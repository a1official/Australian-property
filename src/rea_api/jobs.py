from __future__ import annotations

import json
import sqlite3
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from rea_pipeline.errors import AccessBlockedError, PipelineError
from source_scrapers.models import PropertyQuery
from source_scrapers.rea import RealEstateAuScraper


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class JobStore:
    def __init__(self, database: str | Path) -> None:
        self.database = Path(database)
        self.database.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS scrape_jobs (
                    job_id TEXT PRIMARY KEY,
                    purpose TEXT NOT NULL,
                    status TEXT NOT NULL,
                    request_json TEXT NOT NULL,
                    result_json TEXT,
                    error TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database)
        connection.row_factory = sqlite3.Row
        return connection

    def create(self, purpose: str, request: dict[str, Any]) -> dict[str, Any]:
        job_id = str(uuid4())
        now = _now()
        with self._connect() as connection:
            connection.execute(
                """INSERT INTO scrape_jobs(
                       job_id, purpose, status, request_json, created_at, updated_at
                   ) VALUES (?, ?, 'queued', ?, ?, ?)""",
                (job_id, purpose, json.dumps(request), now, now),
            )
        return self.get(job_id)

    def update(
        self,
        job_id: str,
        status: str,
        *,
        result: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> None:
        with self._connect() as connection:
            connection.execute(
                """UPDATE scrape_jobs
                   SET status=?, result_json=?, error=?, updated_at=?
                   WHERE job_id=?""",
                (
                    status,
                    json.dumps(result, ensure_ascii=False) if result is not None else None,
                    error[:4000] if error else None,
                    _now(),
                    job_id,
                ),
            )

    def get(self, job_id: str) -> dict[str, Any]:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM scrape_jobs WHERE job_id=?", (job_id,)
            ).fetchone()
        if row is None:
            raise KeyError(job_id)
        value = dict(row)
        value["request"] = json.loads(value.pop("request_json"))
        value["result"] = (
            json.loads(value.pop("result_json")) if value["result_json"] else None
        )
        return value


def run_rent_search(store: JobStore, job_id: str, request: dict[str, Any]) -> None:
    store.update(job_id, "running")
    location = request["location"]
    try:
        query = PropertyQuery(
            suburb=location["suburb"],
            state=location["state"],
            postcode=location.get("postcode"),
            property_types=tuple(request.get("property_types") or ()),
            bedrooms_min=request["bedrooms"].get("min"),
            bedrooms_max=request["bedrooms"].get("max"),
            bathrooms_min=request["bathrooms"].get("min"),
            bathrooms_max=request["bathrooms"].get("max"),
            parking_min=request.get("parking_min"),
            weekly_price_min=request["price"].get("min"),
            weekly_price_max=request["price"].get("max"),
            include_surrounding_suburbs=request.get(
                "include_surrounding_suburbs", False
            ),
            max_results=request.get("max_results", 50),
        )
        result = RealEstateAuScraper().search(
            query,
            max_pages=request.get("max_pages", 1),
            headed=False,
        )
        store.update(
            job_id,
            "completed",
            result={
                "pages_fetched": result.pages_fetched,
                "site_total_results": result.site_total_results,
                "listings": [asdict(item) for item in result.listings],
                "source_urls": result.source_urls,
            },
        )
    except AccessBlockedError as exc:
        store.update(job_id, "blocked", error=str(exc))
    except (PipelineError, OSError, ValueError) as exc:
        store.update(job_id, "failed", error=str(exc))
