from __future__ import annotations

import json
import sqlite3
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from rea_pipeline.models import RentalListing, RentalQuery, SearchBatch


_QUERY_SORT_COLUMNS = {
    "last_seen_at": "last_seen_at",
    "first_seen_at": "first_seen_at",
    "weekly_rent": "weekly_rent",
    "bedrooms": "bedrooms",
    "bathrooms": "bathrooms",
    "suburb": "suburb",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect(database: str | Path) -> sqlite3.Connection:
    path = Path(database)
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    _create_schema(connection)
    return connection


def _create_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS ingestion_runs (
            run_id TEXT PRIMARY KEY,
            source_url TEXT NOT NULL,
            fetch_mode TEXT,
            status TEXT NOT NULL,
            started_at TEXT NOT NULL,
            finished_at TEXT,
            total_results INTEGER,
            page INTEGER,
            max_page INTEGER,
            more_results INTEGER,
            row_count INTEGER,
            skipped_count INTEGER,
            resolved_query_json TEXT,
            error TEXT
        );

        CREATE TABLE IF NOT EXISTS rental_listings (
            source TEXT NOT NULL,
            listing_id TEXT NOT NULL,
            canonical_url TEXT,
            full_address TEXT,
            suburb TEXT,
            state TEXT,
            postcode TEXT,
            property_type TEXT,
            bedrooms INTEGER,
            bathrooms INTEGER,
            parking_spaces INTEGER,
            studies INTEGER,
            price_display TEXT,
            weekly_rent INTEGER,
            available_date TEXT,
            bond_display TEXT,
            bond_dollars INTEGER,
            building_size REAL,
            building_size_unit TEXT,
            land_size REAL,
            land_size_unit TEXT,
            inspections_json TEXT NOT NULL,
            description TEXT,
            agency_name TEXT,
            main_image_url TEXT,
            raw_json TEXT NOT NULL,
            first_seen_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL,
            last_run_id TEXT NOT NULL,
            PRIMARY KEY (source, listing_id),
            FOREIGN KEY (last_run_id) REFERENCES ingestion_runs(run_id)
        );

        CREATE INDEX IF NOT EXISTS idx_rentals_location
        ON rental_listings(state, suburb, postcode);

        CREATE INDEX IF NOT EXISTS idx_rentals_comparables
        ON rental_listings(property_type, bedrooms, bathrooms, weekly_rent);
        """
    )
    connection.commit()


def start_run(connection: sqlite3.Connection, run_id: str, source_url: str) -> None:
    connection.execute(
        """INSERT INTO ingestion_runs(run_id, source_url, status, started_at)
           VALUES (?, ?, 'running', ?)""",
        (run_id, source_url, _now()),
    )
    connection.commit()


def complete_run(
    connection: sqlite3.Connection,
    run_id: str,
    fetch_mode: str,
    batch: SearchBatch,
    listings: list[RentalListing],
    skipped_count: int = 0,
) -> None:
    seen_at = _now()
    fields = list(asdict(listings[0]).keys()) if listings else []
    if fields:
        columns = ", ".join(fields)
        placeholders = ", ".join("?" for _ in fields)
        updates = ", ".join(
            f"{field}=excluded.{field}"
            for field in fields
            if field not in {"source", "listing_id"}
        )
        statement = f"""
            INSERT INTO rental_listings(
                {columns}, first_seen_at, last_seen_at, last_run_id
            ) VALUES ({placeholders}, ?, ?, ?)
            ON CONFLICT(source, listing_id) DO UPDATE SET
                {updates}, last_seen_at=excluded.last_seen_at,
                last_run_id=excluded.last_run_id
        """
        for listing in listings:
            values = asdict(listing)
            connection.execute(
                statement,
                [values[field] for field in fields] + [seen_at, seen_at, run_id],
            )

    connection.execute(
        """
        UPDATE ingestion_runs SET
            fetch_mode=?, status='completed', finished_at=?, total_results=?,
            page=?, max_page=?, more_results=?, row_count=?, skipped_count=?,
            resolved_query_json=?
        WHERE run_id=?
        """,
        (
            fetch_mode,
            seen_at,
            batch.total_results,
            batch.page,
            batch.max_page,
            int(batch.more_results) if batch.more_results is not None else None,
            len(listings),
            skipped_count,
            json.dumps(batch.resolved_query, ensure_ascii=False, separators=(",", ":")),
            run_id,
        ),
    )
    connection.commit()


def fail_run(connection: sqlite3.Connection, run_id: str, error: str) -> None:
    connection.execute(
        """UPDATE ingestion_runs
           SET status='failed', finished_at=?, error=? WHERE run_id=?""",
        (_now(), error[:4000], run_id),
    )
    connection.commit()


def list_rentals(
    connection: sqlite3.Connection, limit: int = 20
) -> list[dict[str, Any]]:
    return query_rentals(connection, RentalQuery(limit=limit))["items"]


def query_rentals(
    connection: sqlite3.Connection, query: RentalQuery
) -> dict[str, Any]:
    """Return filtered rows and a matching total using parameterized SQL."""
    _validate_query(query)
    conditions: list[str] = []
    parameters: list[Any] = []

    for column, value in (
        ("source", query.source),
        ("suburb", query.suburb),
        ("state", query.state),
        ("property_type", query.property_type),
    ):
        if value:
            conditions.append(f"lower({column}) = lower(?)")
            parameters.append(value.strip())
    if query.postcode:
        conditions.append("postcode = ?")
        parameters.append(query.postcode.strip())
    if query.text:
        pattern = f"%{_escape_like(query.text.strip())}%"
        conditions.append(
            "(full_address LIKE ? ESCAPE '\\' OR "
            "description LIKE ? ESCAPE '\\' OR agency_name LIKE ? ESCAPE '\\')"
        )
        parameters.extend((pattern, pattern, pattern))

    for column, minimum, maximum in (
        ("bedrooms", query.bedrooms_min, query.bedrooms_max),
        ("bathrooms", query.bathrooms_min, query.bathrooms_max),
        ("weekly_rent", query.weekly_rent_min, query.weekly_rent_max),
    ):
        if minimum is not None:
            conditions.append(f"{column} >= ?")
            parameters.append(minimum)
        if maximum is not None:
            conditions.append(f"{column} <= ?")
            parameters.append(maximum)
    if query.parking_min is not None:
        conditions.append("parking_spaces >= ?")
        parameters.append(query.parking_min)

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    total = connection.execute(
        f"SELECT COUNT(*) FROM rental_listings {where}", parameters
    ).fetchone()[0]
    sort_column = _QUERY_SORT_COLUMNS[query.sort_by]
    sort_order = query.sort_order.upper()
    rows = connection.execute(
        f"""
        SELECT source, listing_id, canonical_url, full_address, suburb, state,
               postcode, property_type, bedrooms, bathrooms, parking_spaces,
               studies, price_display, weekly_rent, available_date,
               bond_display, bond_dollars, building_size, building_size_unit,
               land_size, land_size_unit, agency_name, main_image_url,
               first_seen_at, last_seen_at
        FROM rental_listings
        {where}
        ORDER BY {sort_column} {sort_order}, listing_id ASC
        LIMIT ? OFFSET ?
        """,
        [*parameters, query.limit, query.offset],
    ).fetchall()
    return {
        "total": total,
        "limit": query.limit,
        "offset": query.offset,
        "items": [dict(row) for row in rows],
    }


def _validate_query(query: RentalQuery) -> None:
    if query.limit < 1 or query.limit > 1000:
        raise ValueError("limit must be between 1 and 1000")
    if query.offset < 0:
        raise ValueError("offset cannot be negative")
    if query.sort_by not in _QUERY_SORT_COLUMNS:
        raise ValueError(f"unsupported sort field: {query.sort_by}")
    if query.sort_order not in {"asc", "desc"}:
        raise ValueError("sort_order must be 'asc' or 'desc'")
    for label, minimum, maximum in (
        ("bedrooms", query.bedrooms_min, query.bedrooms_max),
        ("bathrooms", query.bathrooms_min, query.bathrooms_max),
        ("weekly rent", query.weekly_rent_min, query.weekly_rent_max),
    ):
        if minimum is not None and minimum < 0:
            raise ValueError(f"{label} minimum cannot be negative")
        if maximum is not None and maximum < 0:
            raise ValueError(f"{label} maximum cannot be negative")
        if minimum is not None and maximum is not None and minimum > maximum:
            raise ValueError(f"{label} minimum cannot exceed maximum")
    if query.parking_min is not None and query.parking_min < 0:
        raise ValueError("parking minimum cannot be negative")


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
