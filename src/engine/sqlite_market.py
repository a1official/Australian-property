from __future__ import annotations

import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from engine.errors import ValidationError
from engine.models import MarketComparable, MarketRecordKind, SubjectProperty

_WAYBACK_TIMESTAMP = re.compile(r"/web/(\d{14})")


class SQLiteMarketConnector:
    """Read normalized market records produced by the existing REA pipeline."""

    def __init__(self, database: str | Path) -> None:
        self.database = Path(database)

    def fetch(self, subject: SubjectProperty) -> list[MarketComparable]:
        if not self.database.is_file():
            raise ValidationError(f"market database does not exist: {self.database}")
        connection = sqlite3.connect(self.database)
        connection.row_factory = sqlite3.Row
        try:
            rows = connection.execute(
                """
                SELECT l.source, l.listing_id, l.canonical_url, l.full_address,
                       l.suburb, l.state, l.postcode, l.property_type,
                       l.bedrooms, l.bathrooms, l.parking_spaces,
                       l.weekly_rent, l.building_size, l.land_size,
                       l.last_seen_at, r.source_url
                FROM rental_listings AS l
                LEFT JOIN ingestion_runs AS r ON r.run_id = l.last_run_id
                WHERE l.state = ?
                  AND (lower(l.suburb) = lower(?) OR l.postcode = ?)
                  AND l.property_type IS NOT NULL
                  AND l.bedrooms IS NOT NULL
                  AND l.bathrooms IS NOT NULL
                  AND l.parking_spaces IS NOT NULL
                  AND l.weekly_rent IS NOT NULL
                """,
                (subject.state.upper(), subject.suburb, subject.postcode),
            ).fetchall()
        except sqlite3.Error as exc:
            raise ValidationError(f"could not query market database: {exc}") from exc
        finally:
            connection.close()

        return [self._from_row(row) for row in rows]

    @staticmethod
    def _from_row(row: sqlite3.Row) -> MarketComparable:
        collected_at = _source_timestamp(row["source_url"]) or _parse_datetime(
            row["last_seen_at"]
        )
        return MarketComparable(
            source=row["source"],
            listing_id=str(row["listing_id"]),
            canonical_url=row["canonical_url"],
            address=row["full_address"],
            suburb=row["suburb"],
            state=row["state"],
            postcode=str(row["postcode"]),
            property_type=row["property_type"],
            bedrooms=int(row["bedrooms"]),
            bathrooms=int(row["bathrooms"]),
            parking_spaces=int(row["parking_spaces"]),
            weekly_rent=int(row["weekly_rent"]),
            building_size_sqm=row["building_size"],
            land_size_sqm=row["land_size"],
            collected_at=collected_at,
            record_kind=MarketRecordKind.ACTIVE,
        )


def _source_timestamp(source_url: str | None) -> datetime | None:
    if not source_url:
        return None
    match = _WAYBACK_TIMESTAMP.search(source_url)
    if not match:
        return None
    return datetime.strptime(match.group(1), "%Y%m%d%H%M%S").replace(
        tzinfo=timezone.utc
    )


def _parse_datetime(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)

