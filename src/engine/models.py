from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from enum import StrEnum
from typing import Any


class Confidence(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class TenantRating(StrEnum):
    GOOD = "good"
    AVERAGE = "average"
    POOR = "poor"


class MarketRecordKind(StrEnum):
    ACTIVE = "active"
    LEASED = "leased"


@dataclass(frozen=True, slots=True)
class Coordinates:
    latitude: float
    longitude: float


@dataclass(frozen=True, slots=True)
class SubjectProperty:
    property_id: str
    address: str
    suburb: str
    state: str
    postcode: str
    property_type: str
    bedrooms: int
    bathrooms: int
    parking_spaces: int
    current_weekly_rent: int | None = None
    building_size_sqm: float | None = None
    land_size_sqm: float | None = None
    coordinates: Coordinates | None = None


@dataclass(frozen=True, slots=True)
class MarketComparable:
    source: str
    listing_id: str
    address: str | None
    suburb: str
    state: str
    postcode: str
    property_type: str
    bedrooms: int
    bathrooms: int
    parking_spaces: int
    weekly_rent: int
    collected_at: datetime
    canonical_url: str | None = None
    record_kind: MarketRecordKind = MarketRecordKind.ACTIVE
    listed_date: date | None = None
    leased_date: date | None = None
    building_size_sqm: float | None = None
    land_size_sqm: float | None = None
    coordinates: Coordinates | None = None


@dataclass(frozen=True, slots=True)
class TenantMetrics:
    tenancy_id: str
    payments_due: int
    payments_on_time: int
    current_arrears: int
    weekly_rent: int
    breach_count: int
    tenancy_months: int
    inspection_rating: str | None = None


@dataclass(frozen=True, slots=True)
class DataIssue:
    record_id: str
    reason: str


@dataclass(frozen=True, slots=True)
class ComparableMatch:
    comparable: MarketComparable
    score: float
    distance_km: float | None
    reasons: tuple[str, ...]
    components: dict[str, float]


@dataclass(frozen=True, slots=True)
class MarketCalculation:
    records_evaluated: int
    hard_filter_rejections: dict[str, int]
    below_minimum_score: int
    passed_similarity: int
    rent_first_quartile: float | None
    rent_third_quartile: float | None
    rent_iqr: float | None
    rent_lower_bound: float | None
    rent_upper_bound: float | None
    rent_outliers_removed: int
    top_n_excluded: int
    selected_rents: tuple[int, ...]
    selected_median: float
    selected_first_quartile: float
    selected_third_quartile: float
    minimum_score: float
    maximum_comparables: int
    high_confidence_minimum_count: int
    high_confidence_minimum_score: float


@dataclass(frozen=True, slots=True)
class MarketRecommendation:
    suggested_weekly_rent: int
    low_weekly_rent: int
    high_weekly_rent: int
    confidence: Confidence
    average_match_score: float
    selected: tuple[ComparableMatch, ...]
    rejected_count: int
    rule_version: str
    calculation: MarketCalculation


@dataclass(frozen=True, slots=True)
class TenantScore:
    score: int
    rating: TenantRating
    reasons: tuple[str, ...]
    components: dict[str, float]
    rule_version: str


@dataclass(frozen=True, slots=True)
class DeliveryResult:
    destination: str
    status: str
    reference: str | None = None


@dataclass(frozen=True, slots=True)
class EngineReport:
    run_id: str
    generated_at: datetime
    subject: SubjectProperty
    market: MarketRecommendation
    tenant: TenantScore | None
    data_issues: tuple[DataIssue, ...] = ()
    deliveries: tuple[DeliveryResult, ...] = ()
    metadata: dict[str, Any] = field(default_factory=dict)
