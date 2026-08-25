import pytest

from rea_pipeline.models import RentalQuery, SearchBatch
from rea_pipeline.normalizer import normalize_listing
from rea_pipeline.storage import (
    complete_run,
    connect,
    list_rentals,
    query_rentals,
    start_run,
)


def test_upsert_keeps_first_seen_and_updates_price(tmp_path) -> None:
    database = tmp_path / "test.db"
    connection = connect(database)
    batch = SearchBatch(listings=[], total_results=1, page=1, max_page=1)
    raw = {
        "id": "1",
        "address": {"display": {"fullAddress": "1 Test St"}},
        "price": {"display": "$700 per week"},
    }

    start_run(connection, "run-1", "fixture")
    complete_run(connection, "run-1", "file", batch, [normalize_listing(raw)])
    first_seen = connection.execute(
        "SELECT first_seen_at FROM rental_listings WHERE listing_id='1'"
    ).fetchone()[0]

    raw["price"] = {"display": "$720 per week"}
    start_run(connection, "run-2", "fixture")
    complete_run(connection, "run-2", "file", batch, [normalize_listing(raw)])

    row = list_rentals(connection, 1)[0]
    stored_first_seen = connection.execute(
        "SELECT first_seen_at FROM rental_listings WHERE listing_id='1'"
    ).fetchone()[0]
    connection.close()

    assert row["weekly_rent"] == 720
    assert stored_first_seen == first_seen


def test_query_rentals_filters_sorts_and_paginates(tmp_path) -> None:
    connection = connect(tmp_path / "query.db")
    batch = SearchBatch(listings=[], total_results=3, page=1, max_page=1)
    listings = [
        normalize_listing(
            {
                "id": "1",
                "address": {
                    "display": {"fullAddress": "1 Alpha St, Sydney"},
                    "suburb": "Sydney",
                    "state": "NSW",
                    "postcode": "2000",
                },
                "propertyType": {"display": "Apartment"},
                "generalFeatures": {"bedrooms": 2, "bathrooms": 1},
                "price": {"display": "$750 per week"},
            }
        ),
        normalize_listing(
            {
                "id": "2",
                "address": {
                    "display": {"fullAddress": "2 Beta St, Sydney"},
                    "suburb": "Sydney",
                    "state": "NSW",
                    "postcode": "2000",
                },
                "propertyType": {"display": "Apartment"},
                "generalFeatures": {"bedrooms": 3, "bathrooms": 2},
                "price": {"display": "$700 per week"},
            }
        ),
        normalize_listing(
            {
                "id": "3",
                "address": {
                    "display": {"fullAddress": "3 Gamma St, Melbourne"},
                    "suburb": "Melbourne",
                    "state": "VIC",
                    "postcode": "3000",
                },
                "propertyType": {"display": "House"},
                "generalFeatures": {"bedrooms": 4, "bathrooms": 2},
                "price": {"display": "$900 per week"},
            }
        ),
    ]
    start_run(connection, "query-run", "fixture")
    complete_run(connection, "query-run", "file", batch, listings)

    result = query_rentals(
        connection,
        RentalQuery(
            state="nsw",
            property_type="apartment",
            bedrooms_min=2,
            weekly_rent_max=800,
            sort_by="weekly_rent",
            sort_order="asc",
            limit=1,
        ),
    )
    connection.close()

    assert result["total"] == 2
    assert result["limit"] == 1
    assert [row["listing_id"] for row in result["items"]] == ["2"]


def test_query_rentals_rejects_inverted_range(tmp_path) -> None:
    connection = connect(tmp_path / "query.db")
    with pytest.raises(ValueError, match="minimum cannot exceed maximum"):
        query_rentals(
            connection, RentalQuery(weekly_rent_min=900, weekly_rent_max=500)
        )
    connection.close()
