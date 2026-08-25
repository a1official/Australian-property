from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class SearchBatch:
    """Raw listings and page-level metadata extracted from a search payload."""

    listings: list[dict[str, Any]]
    total_results: int | None = None
    page: int | None = None
    max_page: int | None = None
    more_results: bool | None = None
    resolved_query: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class RentalListing:
    source: str
    listing_id: str
    canonical_url: str | None
    full_address: str | None
    suburb: str | None
    state: str | None
    postcode: str | None
    property_type: str | None
    bedrooms: int | None
    bathrooms: int | None
    parking_spaces: int | None
    studies: int | None
    price_display: str | None
    weekly_rent: int | None
    available_date: str | None
    bond_display: str | None
    bond_dollars: int | None
    building_size: float | None
    building_size_unit: str | None
    land_size: float | None
    land_size_unit: str | None
    inspections_json: str
    description: str | None
    agency_name: str | None
    main_image_url: str | None
    raw_json: str


@dataclass(slots=True, frozen=True)
class RentalQuery:
    """Filters and pagination for querying normalized rental listings."""

    source: str | None = None
    text: str | None = None
    suburb: str | None = None
    state: str | None = None
    postcode: str | None = None
    property_type: str | None = None
    bedrooms_min: int | None = None
    bedrooms_max: int | None = None
    bathrooms_min: int | None = None
    bathrooms_max: int | None = None
    parking_min: int | None = None
    weekly_rent_min: int | None = None
    weekly_rent_max: int | None = None
    sort_by: str = "last_seen_at"
    sort_order: str = "desc"
    limit: int = 20
    offset: int = 0
