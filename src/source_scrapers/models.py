from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import StrEnum
from typing import Any

from rea_pipeline.models import RentalListing
from source_scrapers.errors import QueryValidationError


class SearchPurpose(StrEnum):
    RENT = "rent"
    BUY = "buy"


class SourceName(StrEnum):
    REA = "realestate.com.au"
    PROPERTY_TREE = "property_tree"
    RP_DATA = "rp_data"
    PRICEFINDER = "pricefinder"
    SUPPLEMENTARY = "supplementary"


@dataclass(frozen=True, slots=True)
class PropertyQuery:
    suburb: str
    state: str
    postcode: str | None = None
    purpose: SearchPurpose = SearchPurpose.RENT
    property_types: tuple[str, ...] = ()
    bedrooms_min: int | None = None
    bedrooms_max: int | None = None
    bathrooms_min: int | None = None
    bathrooms_max: int | None = None
    parking_min: int | None = None
    weekly_price_min: int | None = None
    weekly_price_max: int | None = None
    radius_km: float = 5.0
    include_surrounding_suburbs: bool = False
    max_results: int = 50

    def __post_init__(self) -> None:
        if not self.suburb.strip() or not self.state.strip():
            raise QueryValidationError("suburb and state are required")
        if self.purpose != SearchPurpose.RENT:
            raise QueryValidationError(
                "the current normalized listing schema supports rent queries only"
            )
        for name in (
            "bedrooms_min",
            "bedrooms_max",
            "bathrooms_min",
            "bathrooms_max",
            "parking_min",
            "weekly_price_min",
            "weekly_price_max",
        ):
            value = getattr(self, name)
            if value is not None and value < 0:
                raise QueryValidationError(f"{name} cannot be negative")
        if (
            self.bedrooms_min is not None
            and self.bedrooms_max is not None
            and self.bedrooms_min > self.bedrooms_max
        ):
            raise QueryValidationError("bedrooms_min cannot exceed bedrooms_max")
        if (
            self.bathrooms_min is not None
            and self.bathrooms_max is not None
            and self.bathrooms_min > self.bathrooms_max
        ):
            raise QueryValidationError("bathrooms_min cannot exceed bathrooms_max")
        if (
            self.weekly_price_min is not None
            and self.weekly_price_max is not None
            and self.weekly_price_min > self.weekly_price_max
        ):
            raise QueryValidationError(
                "weekly_price_min cannot exceed weekly_price_max"
            )
        if self.radius_km <= 0:
            raise QueryValidationError("radius_km must be positive")
        if not 1 <= self.max_results <= 1000:
            raise QueryValidationError("max_results must be between 1 and 1000")

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "PropertyQuery":
        values = dict(payload)
        values["purpose"] = SearchPurpose(values.get("purpose", "rent"))
        property_types = values.get("property_types") or ()
        if isinstance(property_types, str):
            property_types = (property_types,)
        values["property_types"] = tuple(property_types)
        try:
            return cls(**values)
        except TypeError as exc:
            raise QueryValidationError(f"invalid query fields: {exc}") from exc

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["purpose"] = self.purpose.value
        payload["property_types"] = list(self.property_types)
        return payload


@dataclass(slots=True)
class SourceResult:
    source: SourceName
    query: PropertyQuery
    listings: list[RentalListing]
    source_urls: list[str]
    fetch_modes: list[str]
    pages_fetched: int
    site_total_results: int | None = None
    skipped_rows: int = 0
    site_query: dict[str, Any] = field(default_factory=dict)
