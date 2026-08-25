from datetime import datetime, timezone

import pytest

from rea_pipeline.errors import CircuitOpenError
from source_scrapers.models import PropertyQuery
from source_scrapers.rea import REA_SOURCE_KEY, RealEstateAuScraper
from source_scrapers.reliability import (
    AuthorizedJsonExecutor,
    JsonConnectorResponse,
    ReliabilityPolicy,
    SQLiteReliabilityStore,
    bounded_backoff,
    deduplicate_rows,
    make_cache_key,
    parse_retry_after,
)


def test_retry_after_and_bounded_backoff() -> None:
    policy = ReliabilityPolicy(backoff_base_seconds=2, backoff_cap_seconds=10)

    assert parse_retry_after("7") == 7
    assert parse_retry_after("not-a-delay") is None
    assert parse_retry_after(
        "Thu, 01 Jan 2026 00:00:10 GMT",
        now=datetime(2026, 1, 1, tzinfo=timezone.utc),
    ) == 10
    assert bounded_backoff(0, policy) == 2
    assert bounded_backoff(3, policy) == 10
    assert bounded_backoff(0, policy, retry_after_seconds=9) == 9


def test_persistent_circuit_stops_requests_after_threshold(tmp_path) -> None:
    database = tmp_path / "reliability.db"
    store = SQLiteReliabilityStore(database)
    policy = ReliabilityPolicy(
        min_interval_seconds=0,
        circuit_failure_threshold=2,
        circuit_cooldown_seconds=60,
    )

    store.before_request("authorised-provider", policy)
    store.record_failure("authorised-provider", policy, status=503)
    store.before_request("authorised-provider", policy)
    store.record_failure("authorised-provider", policy, status=429)

    with pytest.raises(CircuitOpenError):
        SQLiteReliabilityStore(database).before_request("authorised-provider", policy)

    status = store.status("authorised-provider")
    assert status["failure_count"] == 2
    assert status["circuit_open"] is True
    assert status["last_status"] == 429


def test_success_resets_failure_state(tmp_path) -> None:
    store = SQLiteReliabilityStore(tmp_path / "reliability.db")
    policy = ReliabilityPolicy(
        min_interval_seconds=0,
        circuit_failure_threshold=3,
    )
    store.before_request("authorised-provider", policy)
    store.record_failure("authorised-provider", policy, status=503)
    store.record_success("authorised-provider", status=200)

    status = store.status("authorised-provider")
    assert status["failure_count"] == 0
    assert status["circuit_open"] is False
    assert status["last_status"] == 200


def test_json_cache_is_query_keyed_and_deduplicates_rows(tmp_path) -> None:
    store = SQLiteReliabilityStore(tmp_path / "reliability.db")
    request = {"state": "NSW", "suburb": "Parramatta"}
    cache_key = make_cache_key("authorised-provider", request)
    rows = [
        {"listing_id": "1", "price": 700},
        {"listing_id": "1", "price": 710},
        {"listing_id": "2", "price": 800},
    ]
    unique = deduplicate_rows(rows, ("listing_id",))
    store.put_json(
        "authorised-provider",
        cache_key,
        unique,
        ttl_seconds=60,
    )

    assert store.get_json("authorised-provider", cache_key) == [
        {"listing_id": "1", "price": 700},
        {"listing_id": "2", "price": 800},
    ]
    assert make_cache_key("authorised-provider", request) == cache_key


def test_concurrency_lease_is_persistent_and_released(tmp_path) -> None:
    store = SQLiteReliabilityStore(tmp_path / "reliability.db")
    policy = ReliabilityPolicy(max_concurrency=2)

    first = store.acquire_request_slot("authorised-provider", policy)
    second = store.acquire_request_slot("authorised-provider", policy)
    assert SQLiteReliabilityStore(store.database).active_request_slots(
        "authorised-provider"
    ) == 2

    store.release_request_slot(first)
    store.release_request_slot(second)
    assert store.active_request_slots("authorised-provider") == 0


def test_authorised_executor_retries_then_caches_and_deduplicates(tmp_path) -> None:
    store = SQLiteReliabilityStore(tmp_path / "reliability.db")
    policy = ReliabilityPolicy(
        min_interval_seconds=0,
        max_retries=1,
        backoff_base_seconds=0,
        circuit_failure_threshold=3,
        cache_ttl_seconds=60,
    )
    executor = AuthorizedJsonExecutor(store, policy)
    attempts = 0

    def operation() -> JsonConnectorResponse:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return JsonConnectorResponse(status_code=503)
        return JsonConnectorResponse(
            status_code=200,
            payload=[
                {"listing_id": "1", "price": 700},
                {"listing_id": "1", "price": 710},
            ],
        )

    live, live_mode = executor.execute(
        "authorised-provider",
        {"suburb": "Parramatta"},
        operation,
        dedupe_fields=("listing_id",),
    )
    cached, cache_mode = executor.execute(
        "authorised-provider",
        {"suburb": "Parramatta"},
        operation,
        dedupe_fields=("listing_id",),
    )

    assert attempts == 2
    assert live_mode == "live"
    assert cache_mode == "cache"
    assert live == cached == [{"listing_id": "1", "price": 700}]
    assert store.active_request_slots("authorised-provider") == 0


def test_rea_open_circuit_stops_before_browser_navigation(tmp_path) -> None:
    database = tmp_path / "reliability.db"
    store = SQLiteReliabilityStore(database)
    rea_policy = ReliabilityPolicy(
        min_interval_seconds=30,
        max_retries=0,
        circuit_failure_threshold=1,
        circuit_cooldown_seconds=24 * 60 * 60,
        cache_ttl_seconds=0,
    )
    store.record_failure(REA_SOURCE_KEY, rea_policy, status=429)

    with pytest.raises(CircuitOpenError):
        RealEstateAuScraper().search(
            PropertyQuery(suburb="Parramatta", state="NSW"),
            reliability_database=database,
        )
