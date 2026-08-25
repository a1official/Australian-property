from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from collections.abc import Callable
from contextlib import closing
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence
from uuid import uuid4

from rea_pipeline.errors import AccessBlockedError, CircuitOpenError, FetchError


@dataclass(frozen=True)
class ReliabilityPolicy:
    """Bounded, source-friendly behaviour for an authorised connector."""

    min_interval_seconds: float = 2.0
    max_retries: int = 2
    backoff_base_seconds: float = 2.0
    backoff_cap_seconds: float = 60.0
    circuit_failure_threshold: int = 3
    circuit_cooldown_seconds: float = 300.0
    cache_ttl_seconds: float = 900.0
    max_concurrency: int = 1
    concurrency_lease_seconds: float = 300.0

    def __post_init__(self) -> None:
        numeric_non_negative = (
            self.min_interval_seconds,
            self.backoff_base_seconds,
            self.backoff_cap_seconds,
            self.circuit_cooldown_seconds,
            self.cache_ttl_seconds,
            self.concurrency_lease_seconds,
        )
        if any(value < 0 for value in numeric_non_negative):
            raise ValueError("reliability timing values cannot be negative")
        if self.max_retries < 0:
            raise ValueError("max_retries cannot be negative")
        if self.circuit_failure_threshold < 1:
            raise ValueError("circuit_failure_threshold must be at least 1")
        if self.max_concurrency < 1:
            raise ValueError("max_concurrency must be at least 1")


@dataclass(frozen=True)
class JsonConnectorResponse:
    status_code: int
    payload: Any = None
    headers: Mapping[str, str] = field(default_factory=dict)


def parse_retry_after(value: str | None, *, now: datetime | None = None) -> float | None:
    """Parse Retry-After seconds or an HTTP date into a non-negative delay."""
    if not value:
        return None
    stripped = value.strip()
    try:
        return max(0.0, float(stripped))
    except ValueError:
        pass
    try:
        target = parsedate_to_datetime(stripped)
    except (TypeError, ValueError, OverflowError):
        return None
    if target.tzinfo is None:
        target = target.replace(tzinfo=timezone.utc)
    reference = now or datetime.now(timezone.utc)
    return max(0.0, (target - reference).total_seconds())


def bounded_backoff(
    attempt: int,
    policy: ReliabilityPolicy,
    *,
    retry_after_seconds: float | None = None,
) -> float:
    """Return deterministic exponential backoff, bounded by the policy cap."""
    if attempt < 0:
        raise ValueError("attempt cannot be negative")
    calculated = policy.backoff_base_seconds * (2**attempt)
    if retry_after_seconds is not None:
        calculated = max(calculated, retry_after_seconds)
    return min(policy.backoff_cap_seconds, calculated)


def make_cache_key(source_key: str, request: Mapping[str, Any]) -> str:
    canonical = json.dumps(request, sort_keys=True, separators=(",", ":"), default=str)
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return f"{source_key}:{digest}"


def deduplicate_rows(
    rows: Iterable[Mapping[str, Any]], key_fields: Sequence[str]
) -> list[dict[str, Any]]:
    """Keep the first normalized row for each stable composite identity."""
    if not key_fields:
        raise ValueError("at least one deduplication key field is required")
    seen: set[tuple[Any, ...]] = set()
    unique: list[dict[str, Any]] = []
    for row in rows:
        identity = tuple(row.get(field) for field in key_fields)
        if identity in seen:
            continue
        seen.add(identity)
        unique.append(dict(row))
    return unique


class SQLiteReliabilityStore:
    """Cross-process throttle, circuit state, and JSON cache in SQLite."""

    def __init__(self, database: str | Path) -> None:
        self.database = Path(database)
        self.database.parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as connection, connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS source_reliability (
                    source_key TEXT PRIMARY KEY,
                    failure_count INTEGER NOT NULL DEFAULT 0,
                    circuit_open_until REAL,
                    last_status INTEGER,
                    last_error TEXT,
                    last_attempt_at REAL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS source_response_cache (
                    cache_key TEXT PRIMARY KEY,
                    source_key TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    expires_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_source_cache_expiry
                    ON source_response_cache(expires_at);
                CREATE TABLE IF NOT EXISTS source_request_leases (
                    lease_id TEXT PRIMARY KEY,
                    source_key TEXT NOT NULL,
                    expires_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_source_lease_expiry
                    ON source_request_leases(source_key, expires_at);
                """
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database, timeout=30)
        connection.row_factory = sqlite3.Row
        return connection

    @staticmethod
    def _timestamp() -> str:
        return datetime.now(timezone.utc).isoformat(timespec="seconds")

    def before_request(self, source_key: str, policy: ReliabilityPolicy) -> None:
        """Fail if the circuit is open, then reserve the next request slot."""
        while True:
            now = time.time()
            with closing(self._connect()) as connection:
                connection.execute("BEGIN IMMEDIATE")
                row = connection.execute(
                    "SELECT * FROM source_reliability WHERE source_key=?",
                    (source_key,),
                ).fetchone()
                if row and row["circuit_open_until"]:
                    remaining = float(row["circuit_open_until"]) - now
                    if remaining > 0:
                        connection.commit()
                        raise CircuitOpenError(
                            f"{source_key} collection is paused for another "
                            f"{remaining:.0f} seconds after source refusals"
                        )
                    connection.execute(
                        """UPDATE source_reliability
                           SET failure_count=0, circuit_open_until=NULL, updated_at=?
                           WHERE source_key=?""",
                        (self._timestamp(), source_key),
                    )

                last_attempt = float(row["last_attempt_at"]) if row and row["last_attempt_at"] else None
                wait_seconds = (
                    max(0.0, last_attempt + policy.min_interval_seconds - now)
                    if last_attempt is not None
                    else 0.0
                )
                if wait_seconds <= 0:
                    connection.execute(
                        """INSERT INTO source_reliability(
                               source_key, last_attempt_at, updated_at
                           ) VALUES (?, ?, ?)
                           ON CONFLICT(source_key) DO UPDATE SET
                               last_attempt_at=excluded.last_attempt_at,
                               updated_at=excluded.updated_at""",
                        (source_key, now, self._timestamp()),
                    )
                    connection.commit()
                    return
                connection.commit()
            time.sleep(wait_seconds)

    def acquire_request_slot(
        self,
        source_key: str,
        policy: ReliabilityPolicy,
        *,
        poll_seconds: float = 0.25,
    ) -> str:
        """Acquire a cross-process concurrency lease for one source."""
        lease_id = str(uuid4())
        while True:
            now = time.time()
            with closing(self._connect()) as connection:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute(
                    "DELETE FROM source_request_leases WHERE expires_at<=?",
                    (now,),
                )
                active = connection.execute(
                    """SELECT COUNT(*) FROM source_request_leases
                       WHERE source_key=?""",
                    (source_key,),
                ).fetchone()[0]
                if int(active) < policy.max_concurrency:
                    connection.execute(
                        """INSERT INTO source_request_leases(
                               lease_id, source_key, expires_at
                           ) VALUES (?, ?, ?)""",
                        (
                            lease_id,
                            source_key,
                            now + policy.concurrency_lease_seconds,
                        ),
                    )
                    connection.commit()
                    return lease_id
                connection.commit()
            time.sleep(max(0.05, poll_seconds))

    def release_request_slot(self, lease_id: str) -> None:
        with closing(self._connect()) as connection, connection:
            connection.execute(
                "DELETE FROM source_request_leases WHERE lease_id=?",
                (lease_id,),
            )

    def active_request_slots(self, source_key: str) -> int:
        now = time.time()
        with closing(self._connect()) as connection, connection:
            connection.execute(
                "DELETE FROM source_request_leases WHERE expires_at<=?",
                (now,),
            )
            return int(
                connection.execute(
                    """SELECT COUNT(*) FROM source_request_leases
                       WHERE source_key=?""",
                    (source_key,),
                ).fetchone()[0]
            )

    def record_success(self, source_key: str, *, status: int | None = None) -> None:
        with closing(self._connect()) as connection, connection:
            connection.execute(
                """INSERT INTO source_reliability(
                       source_key, failure_count, circuit_open_until,
                       last_status, last_error, updated_at
                   ) VALUES (?, 0, NULL, ?, NULL, ?)
                   ON CONFLICT(source_key) DO UPDATE SET
                       failure_count=0,
                       circuit_open_until=NULL,
                       last_status=excluded.last_status,
                       last_error=NULL,
                       updated_at=excluded.updated_at""",
                (source_key, status, self._timestamp()),
            )

    def record_failure(
        self,
        source_key: str,
        policy: ReliabilityPolicy,
        *,
        status: int | None = None,
        error: str | None = None,
        retry_after_seconds: float | None = None,
    ) -> None:
        now = time.time()
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT failure_count FROM source_reliability WHERE source_key=?",
                (source_key,),
            ).fetchone()
            failures = (int(row["failure_count"]) if row else 0) + 1
            open_until = None
            if failures >= policy.circuit_failure_threshold:
                cooldown = max(
                    policy.circuit_cooldown_seconds,
                    retry_after_seconds or 0.0,
                )
                open_until = now + cooldown
            connection.execute(
                """INSERT INTO source_reliability(
                       source_key, failure_count, circuit_open_until,
                       last_status, last_error, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT(source_key) DO UPDATE SET
                       failure_count=excluded.failure_count,
                       circuit_open_until=excluded.circuit_open_until,
                       last_status=excluded.last_status,
                       last_error=excluded.last_error,
                       updated_at=excluded.updated_at""",
                (
                    source_key,
                    failures,
                    open_until,
                    status,
                    (error or "")[:1000] or None,
                    self._timestamp(),
                ),
            )
            connection.commit()

    def get_json(self, source_key: str, cache_key: str) -> Any | None:
        now = time.time()
        with closing(self._connect()) as connection, connection:
            row = connection.execute(
                """SELECT payload_json, expires_at FROM source_response_cache
                   WHERE cache_key=? AND source_key=?""",
                (cache_key, source_key),
            ).fetchone()
            if row is None:
                return None
            if float(row["expires_at"]) <= now:
                connection.execute(
                    "DELETE FROM source_response_cache WHERE cache_key=?",
                    (cache_key,),
                )
                return None
            return json.loads(row["payload_json"])

    def put_json(
        self,
        source_key: str,
        cache_key: str,
        payload: Any,
        *,
        ttl_seconds: float,
    ) -> None:
        if ttl_seconds <= 0:
            return
        now = time.time()
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        with closing(self._connect()) as connection, connection:
            connection.execute(
                """INSERT INTO source_response_cache(
                       cache_key, source_key, payload_json, created_at, expires_at
                   ) VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(cache_key) DO UPDATE SET
                       source_key=excluded.source_key,
                       payload_json=excluded.payload_json,
                       created_at=excluded.created_at,
                       expires_at=excluded.expires_at""",
                (cache_key, source_key, encoded, now, now + ttl_seconds),
            )

    def status(self, source_key: str) -> dict[str, Any]:
        with closing(self._connect()) as connection:
            row = connection.execute(
                "SELECT * FROM source_reliability WHERE source_key=?",
                (source_key,),
            ).fetchone()
        if row is None:
            return {
                "source_key": source_key,
                "failure_count": 0,
                "circuit_open": False,
                "circuit_open_until": None,
                "last_status": None,
                "last_error": None,
                "last_attempt_at": None,
                "active_request_slots": self.active_request_slots(source_key),
            }
        value = dict(row)
        value["circuit_open"] = bool(
            value["circuit_open_until"]
            and float(value["circuit_open_until"]) > time.time()
        )
        value["active_request_slots"] = self.active_request_slots(source_key)
        return value


class AuthorizedJsonExecutor:
    """Execute a contract-authorised JSON request under all reliability controls."""

    _RETRYABLE_STATUSES = {408, 425, 429, 500, 502, 503, 504}

    def __init__(
        self,
        store: SQLiteReliabilityStore,
        policy: ReliabilityPolicy | None = None,
    ) -> None:
        self.store = store
        self.policy = policy or ReliabilityPolicy()

    def execute(
        self,
        source_key: str,
        request: Mapping[str, Any],
        operation: Callable[[], JsonConnectorResponse],
        *,
        dedupe_fields: Sequence[str] = (),
    ) -> tuple[Any, str]:
        cache_key = make_cache_key(source_key, request)
        cached = self.store.get_json(source_key, cache_key)
        if cached is not None:
            return cached, "cache"

        lease_id = self.store.acquire_request_slot(source_key, self.policy)
        try:
            # Another worker may have populated the cache while this one queued.
            cached = self.store.get_json(source_key, cache_key)
            if cached is not None:
                return cached, "cache"

            for attempt in range(self.policy.max_retries + 1):
                self.store.before_request(source_key, self.policy)
                response = operation()
                status = response.status_code
                if 200 <= status < 300:
                    payload = response.payload
                    if dedupe_fields and isinstance(payload, list):
                        payload = deduplicate_rows(payload, dedupe_fields)
                    self.store.record_success(source_key, status=status)
                    self.store.put_json(
                        source_key,
                        cache_key,
                        payload,
                        ttl_seconds=self.policy.cache_ttl_seconds,
                    )
                    return payload, "live"

                retry_after = parse_retry_after(
                    next(
                        (
                            value
                            for name, value in response.headers.items()
                            if name.casefold() == "retry-after"
                        ),
                        None,
                    )
                )
                self.store.record_failure(
                    source_key,
                    self.policy,
                    status=status,
                    error=f"authorised connector returned HTTP {status}",
                    retry_after_seconds=retry_after,
                )
                can_retry = (
                    status in self._RETRYABLE_STATUSES
                    and attempt < self.policy.max_retries
                )
                if not can_retry:
                    if status in {401, 403, 429}:
                        raise AccessBlockedError(
                            f"authorised connector returned HTTP {status}"
                        )
                    raise FetchError(f"authorised connector returned HTTP {status}")
                time.sleep(
                    bounded_backoff(
                        attempt,
                        self.policy,
                        retry_after_seconds=retry_after,
                    )
                )
        finally:
            self.store.release_request_slot(lease_id)

        raise FetchError("authorised connector exhausted its retry policy")
