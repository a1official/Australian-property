from __future__ import annotations

from dataclasses import replace
from typing import Iterable

from engine.errors import ValidationError
from engine.models import DataIssue, MarketComparable, SubjectProperty

_PROPERTY_TYPE_ALIASES = {
    "apartment": "apartment",
    "flat": "apartment",
    "unit": "apartment",
    "house": "house",
    "terrace": "house",
    "townhouse": "townhouse",
    "villa": "villa",
    "studio": "studio",
}


def canonical_property_type(value: str) -> str:
    normalized = value.strip().lower()
    return _PROPERTY_TYPE_ALIASES.get(normalized, normalized)


def normalize_subject(subject: SubjectProperty) -> SubjectProperty:
    if not subject.property_id.strip():
        raise ValidationError("subject property_id is required")
    if not subject.address.strip() or not subject.suburb.strip():
        raise ValidationError("subject address and suburb are required")
    if subject.bedrooms < 0 or subject.bathrooms < 0 or subject.parking_spaces < 0:
        raise ValidationError("subject feature counts cannot be negative")
    if subject.current_weekly_rent is not None and subject.current_weekly_rent <= 0:
        raise ValidationError("subject current_weekly_rent must be positive")
    return replace(
        subject,
        suburb=subject.suburb.strip(),
        state=subject.state.strip().upper(),
        postcode=subject.postcode.strip(),
        property_type=canonical_property_type(subject.property_type),
    )


def normalize_comparables(
    records: Iterable[MarketComparable],
) -> tuple[list[MarketComparable], list[DataIssue]]:
    normalized: list[MarketComparable] = []
    issues: list[DataIssue] = []
    seen: set[tuple[str, str]] = set()

    for record in records:
        identity = (record.source, record.listing_id)
        if not record.listing_id.strip():
            issues.append(DataIssue("unknown", "missing listing id"))
            continue
        if identity in seen:
            issues.append(DataIssue(record.listing_id, "duplicate source listing"))
            continue
        seen.add(identity)
        if record.weekly_rent <= 0 or record.weekly_rent > 20_000:
            issues.append(DataIssue(record.listing_id, "weekly rent outside valid range"))
            continue
        if min(record.bedrooms, record.bathrooms, record.parking_spaces) < 0:
            issues.append(DataIssue(record.listing_id, "negative feature count"))
            continue
        if not record.suburb.strip() or not record.state.strip():
            issues.append(DataIssue(record.listing_id, "missing locality"))
            continue
        normalized.append(
            replace(
                record,
                suburb=record.suburb.strip(),
                state=record.state.strip().upper(),
                postcode=record.postcode.strip(),
                property_type=canonical_property_type(record.property_type),
            )
        )
    return normalized, issues
