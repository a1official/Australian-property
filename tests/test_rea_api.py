import importlib

from fastapi.testclient import TestClient

from rea_api.app import create_app
from rea_pipeline.models import SearchBatch
from rea_pipeline.normalizer import normalize_listing
from rea_pipeline.storage import complete_run, connect, start_run


def client(tmp_path) -> TestClient:
    return TestClient(
        create_app(database=tmp_path / "api.db", execute_jobs=False)
    )


def test_sitemap_lists_purpose_specific_pages(tmp_path) -> None:
    response = client(tmp_path).get("/api/v1/sitemap")

    assert response.status_code == 200
    rows = response.json()
    assert len(rows) == 8
    assert {row["id"] for row in rows} >= {
        "rent_search",
        "sold_search",
        "listing_detail",
        "suburb_profile",
    }
    assert next(row for row in rows if row["id"] == "rent_search")["status"] == "implemented"


def test_rent_search_creates_validated_async_job(tmp_path) -> None:
    response = client(tmp_path).post(
        "/api/v1/jobs/rent-search",
        json={
            "location": {"suburb": "Parramatta", "state": "NSW", "postcode": "2150"},
            "property_types": ["apartment"],
            "bedrooms": {"min": 2},
            "bathrooms": {"min": 1},
            "price": {"min": 500, "max": 850},
            "max_pages": 2,
            "max_results": 50,
        },
    )

    assert response.status_code == 202
    job = response.json()
    assert job["purpose"] == "rent_search"
    assert job["status"] == "queued"
    status_response = client(tmp_path).get(f"/api/v1/jobs/{job['job_id']}")
    assert status_response.status_code == 200


def test_query_range_validation(tmp_path) -> None:
    response = client(tmp_path).post(
        "/api/v1/jobs/rent-search",
        json={
            "location": {"suburb": "Sydney", "state": "NSW"},
            "bedrooms": {"min": 3, "max": 2},
        },
    )

    assert response.status_code == 422


def test_contract_only_endpoint_fails_explicitly(tmp_path) -> None:
    response = client(tmp_path).post(
        "/api/v1/jobs/sold-search",
        json={"location": {"suburb": "Parramatta", "state": "NSW"}},
    )

    assert response.status_code == 501
    assert response.json()["detail"]["purpose"] == "sold_search"


def test_listings_endpoint_queries_stored_rows(tmp_path) -> None:
    database = tmp_path / "api.db"
    connection = connect(database)
    start_run(connection, "api-query-run", "fixture")
    complete_run(
        connection,
        "api-query-run",
        "file",
        SearchBatch(listings=[], total_results=2),
        [
            normalize_listing(
                {
                    "id": "api-1",
                    "address": {
                        "display": {"fullAddress": "1 Query St, Parramatta"},
                        "suburb": "Parramatta",
                        "state": "NSW",
                        "postcode": "2150",
                    },
                    "propertyType": {"display": "Apartment"},
                    "generalFeatures": {"bedrooms": 2, "bathrooms": 1},
                    "price": {"display": "$650 per week"},
                }
            ),
            normalize_listing(
                {
                    "id": "api-2",
                    "address": {
                        "display": {"fullAddress": "2 Query St, Parramatta"},
                        "suburb": "Parramatta",
                        "state": "NSW",
                        "postcode": "2150",
                    },
                    "propertyType": {"display": "House"},
                    "generalFeatures": {"bedrooms": 4, "bathrooms": 2},
                    "price": {"display": "$950 per week"},
                }
            ),
        ],
    )
    connection.close()

    response = TestClient(create_app(database=database, execute_jobs=False)).get(
        "/api/v1/listings",
        params={
            "suburb": "Parramatta",
            "property_type": "apartment",
            "weekly_rent_max": 700,
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 1
    assert body["items"][0]["listing_id"] == "api-1"


def test_listings_endpoint_rejects_inverted_range(tmp_path) -> None:
    response = client(tmp_path).get(
        "/api/v1/listings",
        params={"bedrooms_min": 3, "bedrooms_max": 1},
    )

    assert response.status_code == 422


def test_rea_partner_status_is_safe_without_credentials(tmp_path, monkeypatch) -> None:
    monkeypatch.delenv("REA_PARTNER_CLIENT_ID", raising=False)
    monkeypatch.delenv("REA_PARTNER_CLIENT_SECRET", raising=False)

    response = client(tmp_path).get("/api/v1/connectors/rea-partner")

    assert response.status_code == 200
    assert response.json()["configured"] is False
    assert "credential" not in response.text.casefold() or "add rea partner" in response.text.casefold()


def test_rea_partner_sync_requires_server_credentials(tmp_path, monkeypatch) -> None:
    monkeypatch.delenv("REA_PARTNER_CLIENT_ID", raising=False)
    monkeypatch.delenv("REA_PARTNER_CLIENT_SECRET", raising=False)

    response = client(tmp_path).post(
        "/api/v1/connectors/rea-partner/sync", json={}
    )

    assert response.status_code == 503


def test_rea_partner_sync_checks_optional_admin_token(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("REA_PARTNER_CLIENT_ID", "configured")
    monkeypatch.setenv("REA_PARTNER_CLIENT_SECRET", "configured")
    monkeypatch.setenv("REA_SYNC_ADMIN_TOKEN", "server-only-token")

    response = client(tmp_path).post(
        "/api/v1/connectors/rea-partner/sync", json={}
    )

    assert response.status_code == 401


def test_abs_market_context_endpoint_returns_normalized_data(tmp_path, monkeypatch) -> None:
    app_module = importlib.import_module("rea_api.app")
    monkeypatch.setattr(
        app_module,
        "get_abs_market_context",
        lambda postcode: {
            "postcode": postcode,
            "area_name": "2000, NSW",
            "geography_type": "2021 Postal Area",
            "reference_period": "2021 Census",
            "population": 27_936,
            "median_age_years": 32,
            "private_dwellings": 16_534,
            "average_household_size": 2.1,
            "median_weekly_household_income": 2_225,
            "median_monthly_mortgage_repayment": 2_800,
            "median_weekly_rent": 625,
            "irsad_score": 1106.97,
            "irsad_decile": 10,
            "irsad_percentile": 93,
            "irsd_score": 973.06,
            "irsd_decile": 4,
            "irsd_percentile": 33,
            "source": "Australian Bureau of Statistics",
            "source_url": "https://www.abs.gov.au/census/find-census-data/quickstats/2021/POA2000",
            "retrieved_at": "2026-08-12T00:00:00Z",
        },
    )

    response = client(tmp_path).get(
        "/api/v1/market-context/abs", params={"postcode": "2000"}
    )

    assert response.status_code == 200
    assert response.json()["population"] == 27_936
    assert response.json()["median_weekly_rent"] == 625


def test_abs_market_context_endpoint_validates_postcode(tmp_path) -> None:
    response = client(tmp_path).get(
        "/api/v1/market-context/abs", params={"postcode": "20"}
    )

    assert response.status_code == 422
