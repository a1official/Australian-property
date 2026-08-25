from __future__ import annotations

import os
import secrets
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from fastapi import BackgroundTasks, FastAPI, Header, HTTPException, Query, status

from rea_api.jobs import JobStore, run_rent_search
from rea_api.models import (
    ABSMarketContextResponse,
    DirectorySearchRequest,
    JobResponse,
    JobResultResponse,
    ListingQueryResponse,
    ListingDetailRequest,
    ConnectorStatusResponse,
    PropertyProfileRequest,
    REAPartnerSyncRequest,
    REAPartnerSyncResponse,
    SearchJobRequest,
    SuburbProfileRequest,
)
from rea_pipeline.abs_context import ABSContextError, get_abs_market_context
from rea_api.sitemap import load_sitemap, sitemap_item
from rea_pipeline.models import RentalQuery
from rea_pipeline.errors import FetchError
from rea_pipeline.rea_partner import rea_partner_is_configured, sync_rea_listings
from rea_pipeline.storage import connect, query_rentals


def _job_response(value: dict[str, Any]) -> JobResponse:
    return JobResponse(
        job_id=value["job_id"],
        purpose=value["purpose"],
        status=value["status"],
        created_at=datetime.fromisoformat(value["created_at"]),
        updated_at=datetime.fromisoformat(value["updated_at"]),
        error=value["error"],
    )


def create_app(
    *,
    database: str | Path | None = None,
    execute_jobs: bool = True,
) -> FastAPI:
    path = Path(database or os.getenv("REA_API_DATABASE", "data/realstate.db"))
    store = JobStore(path)
    application = FastAPI(
        title="Rental Listing Intelligence API",
        version="0.1.0",
        description=(
            "Search normalized rental records and synchronize customer-authorised "
            "listings through supported source connectors."
        ),
    )

    @application.get("/api/v1/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "database": str(path.resolve())}

    @application.get("/api/v1/sitemap")
    def sitemap() -> list[dict[str, Any]]:
        return load_sitemap()

    @application.get(
        "/api/v1/connectors/rea-partner", response_model=ConnectorStatusResponse
    )
    def rea_partner_status() -> ConnectorStatusResponse:
        configured = rea_partner_is_configured()
        return ConnectorStatusResponse(
            provider="REA Partner Platform",
            configured=configured,
            mode="Listing Export API / REAXML",
            scope="listing:listings:export",
            message=(
                "Ready to sync customer-authorised listings."
                if configured
                else "Add REA Partner credentials to enable authorised listing sync."
            ),
        )

    @application.post(
        "/api/v1/connectors/rea-partner/sync",
        response_model=REAPartnerSyncResponse,
    )
    def sync_rea_partner(
        request: REAPartnerSyncRequest,
        x_admin_token: str | None = Header(default=None),
    ) -> REAPartnerSyncResponse:
        expected_token = os.getenv("REA_SYNC_ADMIN_TOKEN", "").strip()
        if expected_token and (
            not x_admin_token or not secrets.compare_digest(x_admin_token, expected_token)
        ):
            raise HTTPException(status_code=401, detail="Invalid sync administrator token.")
        if not rea_partner_is_configured():
            raise HTTPException(
                status_code=503,
                detail=(
                    "REA Partner credentials are not configured. Set "
                    "REA_PARTNER_CLIENT_ID and REA_PARTNER_CLIENT_SECRET."
                ),
            )
        try:
            result = sync_rea_listings(
                path,
                agency_id=request.agency_id,
                max_pages=request.max_pages,
            )
        except (FetchError, OSError, ValueError) as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        return REAPartnerSyncResponse(
            run_id=result.run_id,
            imported=result.imported,
            skipped=result.skipped,
            pages=result.pages,
            agency_id=result.agency_id,
        )

    @application.get(
        "/api/v1/listings", response_model=ListingQueryResponse
    )
    def listings(
        source: str | None = Query(default=None, max_length=100),
        text: str | None = Query(default=None, max_length=200),
        suburb: str | None = Query(default=None, max_length=100),
        state: str | None = Query(default=None, min_length=2, max_length=3),
        postcode: str | None = Query(default=None, pattern=r"^[0-9]{4}$"),
        property_type: str | None = Query(default=None, max_length=100),
        bedrooms_min: int | None = Query(default=None, ge=0),
        bedrooms_max: int | None = Query(default=None, ge=0),
        bathrooms_min: int | None = Query(default=None, ge=0),
        bathrooms_max: int | None = Query(default=None, ge=0),
        parking_min: int | None = Query(default=None, ge=0),
        weekly_rent_min: int | None = Query(default=None, ge=0),
        weekly_rent_max: int | None = Query(default=None, ge=0),
        sort_by: Literal[
            "last_seen_at",
            "first_seen_at",
            "weekly_rent",
            "bedrooms",
            "bathrooms",
            "suburb",
        ] = "last_seen_at",
        sort_order: Literal["asc", "desc"] = "desc",
        limit: int = Query(default=20, ge=1, le=1000),
        offset: int = Query(default=0, ge=0),
    ) -> ListingQueryResponse:
        value = RentalQuery(
            source=source,
            text=text,
            suburb=suburb,
            state=state,
            postcode=postcode,
            property_type=property_type,
            bedrooms_min=bedrooms_min,
            bedrooms_max=bedrooms_max,
            bathrooms_min=bathrooms_min,
            bathrooms_max=bathrooms_max,
            parking_min=parking_min,
            weekly_rent_min=weekly_rent_min,
            weekly_rent_max=weekly_rent_max,
            sort_by=sort_by,
            sort_order=sort_order,
            limit=limit,
            offset=offset,
        )
        connection = connect(path)
        try:
            result = query_rentals(connection, value)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        finally:
            connection.close()
        return ListingQueryResponse.model_validate(result)

    @application.get(
        "/api/v1/market-context/abs",
        response_model=ABSMarketContextResponse,
    )
    def abs_market_context(
        postcode: str = Query(pattern=r"^[0-9]{4}$"),
    ) -> ABSMarketContextResponse:
        try:
            context = get_abs_market_context(postcode)
        except ABSContextError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        return ABSMarketContextResponse.model_validate(context)

    @application.post(
        "/api/v1/jobs/rent-search",
        response_model=JobResponse,
        status_code=status.HTTP_202_ACCEPTED,
    )
    def rent_search(
        request: SearchJobRequest, background_tasks: BackgroundTasks
    ) -> JobResponse:
        payload = request.model_dump(mode="json")
        job = store.create("rent_search", payload)
        if execute_jobs:
            background_tasks.add_task(run_rent_search, store, job["job_id"], payload)
        return _job_response(job)

    def unavailable(purpose: str) -> None:
        item = sitemap_item(purpose)
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail={
                "purpose": purpose,
                "status": item["status"],
                "message": "API contract exists; rendered-page parser is not implemented yet.",
            },
        )

    @application.post("/api/v1/jobs/buy-search", status_code=501)
    def buy_search(_: SearchJobRequest) -> None:
        unavailable("buy_search")

    @application.post("/api/v1/jobs/sold-search", status_code=501)
    def sold_search(_: SearchJobRequest) -> None:
        unavailable("sold_search")

    @application.post("/api/v1/jobs/listing-detail", status_code=501)
    def listing_detail(_: ListingDetailRequest) -> None:
        unavailable("listing_detail")

    @application.post("/api/v1/jobs/property-profile", status_code=501)
    def property_profile(_: PropertyProfileRequest) -> None:
        unavailable("property_profile")

    @application.post("/api/v1/jobs/suburb-profile", status_code=501)
    def suburb_profile(_: SuburbProfileRequest) -> None:
        unavailable("suburb_profile")

    @application.post("/api/v1/jobs/agent-search", status_code=501)
    def agent_search(_: DirectorySearchRequest) -> None:
        unavailable("agent_search")

    @application.post("/api/v1/jobs/agency-search", status_code=501)
    def agency_search(_: DirectorySearchRequest) -> None:
        unavailable("agency_search")

    @application.get("/api/v1/jobs/{job_id}", response_model=JobResponse)
    def get_job(job_id: str) -> JobResponse:
        try:
            return _job_response(store.get(job_id))
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="job not found") from exc

    @application.get(
        "/api/v1/jobs/{job_id}/results", response_model=JobResultResponse
    )
    def get_results(job_id: str) -> JobResultResponse:
        try:
            job = store.get(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="job not found") from exc
        if job["status"] != "completed":
            raise HTTPException(
                status_code=409,
                detail={"status": job["status"], "error": job["error"]},
            )
        return JobResultResponse(job=_job_response(job), result=job["result"])

    return application


app = create_app()
