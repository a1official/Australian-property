from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field, HttpUrl, model_validator


class JobStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    BLOCKED = "blocked"
    FAILED = "failed"


class LocationInput(BaseModel):
    suburb: str = Field(min_length=1, max_length=100)
    state: str = Field(min_length=2, max_length=3)
    postcode: str | None = Field(default=None, pattern=r"^[0-9]{4}$")


class RangeInput(BaseModel):
    min: int | None = Field(default=None, ge=0)
    max: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def ordered(self) -> "RangeInput":
        if self.min is not None and self.max is not None and self.min > self.max:
            raise ValueError("min cannot exceed max")
        return self


class SearchJobRequest(BaseModel):
    location: LocationInput
    property_types: list[str] = Field(default_factory=list, max_length=20)
    bedrooms: RangeInput = Field(default_factory=RangeInput)
    bathrooms: RangeInput = Field(default_factory=RangeInput)
    parking_min: int | None = Field(default=None, ge=0)
    price: RangeInput = Field(default_factory=RangeInput)
    include_surrounding_suburbs: bool = False
    max_pages: int = Field(default=1, ge=1, le=50)
    max_results: int = Field(default=50, ge=1, le=1000)


class ListingDetailRequest(BaseModel):
    canonical_url: HttpUrl


class PropertyProfileRequest(BaseModel):
    address: str = Field(min_length=5, max_length=300)


class SuburbProfileRequest(BaseModel):
    location: LocationInput
    property_types: list[str] = Field(default_factory=list, max_length=20)
    bedrooms: list[int] = Field(default_factory=list, max_length=10)


class DirectorySearchRequest(BaseModel):
    location: LocationInput
    max_pages: int = Field(default=1, ge=1, le=20)


class JobResponse(BaseModel):
    job_id: str
    purpose: str
    status: JobStatus
    created_at: datetime
    updated_at: datetime
    error: str | None = None


class JobResultResponse(BaseModel):
    job: JobResponse
    result: dict[str, Any]


class StoredRentalListing(BaseModel):
    source: str
    listing_id: str
    canonical_url: str | None = None
    full_address: str | None = None
    suburb: str | None = None
    state: str | None = None
    postcode: str | None = None
    property_type: str | None = None
    bedrooms: int | None = None
    bathrooms: int | None = None
    parking_spaces: int | None = None
    studies: int | None = None
    price_display: str | None = None
    weekly_rent: int | None = None
    available_date: str | None = None
    bond_display: str | None = None
    bond_dollars: int | None = None
    building_size: float | None = None
    building_size_unit: str | None = None
    land_size: float | None = None
    land_size_unit: str | None = None
    agency_name: str | None = None
    main_image_url: str | None = None
    first_seen_at: datetime
    last_seen_at: datetime


class ListingQueryResponse(BaseModel):
    total: int
    limit: int
    offset: int
    items: list[StoredRentalListing]


class REAPartnerSyncRequest(BaseModel):
    agency_id: str | None = Field(default=None, min_length=1, max_length=40)
    max_pages: int = Field(default=20, ge=1, le=100)


class REAPartnerSyncResponse(BaseModel):
    run_id: str
    imported: int
    skipped: int
    pages: int
    agency_id: str | None = None


class ConnectorStatusResponse(BaseModel):
    provider: str
    configured: bool
    mode: str
    scope: str
    message: str


class ABSMarketContextResponse(BaseModel):
    postcode: str = Field(pattern=r"^[0-9]{4}$")
    area_name: str
    geography_type: str
    reference_period: str
    population: int
    median_age_years: float
    private_dwellings: int
    average_household_size: float | None = None
    median_weekly_household_income: int | None = None
    median_monthly_mortgage_repayment: int | None = None
    median_weekly_rent: int | None = None
    irsad_score: float | None = None
    irsad_decile: int | None = Field(default=None, ge=1, le=10)
    irsad_percentile: int | None = Field(default=None, ge=1, le=100)
    irsd_score: float | None = None
    irsd_decile: int | None = Field(default=None, ge=1, le=10)
    irsd_percentile: int | None = Field(default=None, ge=1, le=100)
    source: str
    source_url: HttpUrl
    retrieved_at: datetime
