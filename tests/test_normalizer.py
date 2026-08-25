from rea_pipeline.normalizer import normalize_listing, parse_weekly_rent


def test_parse_weekly_rent_periods_and_range() -> None:
    assert parse_weekly_rent("$795 per week") == 795
    assert parse_weekly_rent("$700 - $800 pw") == 750
    assert parse_weekly_rent("$3,250 per month") == 750
    assert parse_weekly_rent("$1,600 per fortnight") == 800
    assert parse_weekly_rent("Contact agent") is None


def test_normalize_listing() -> None:
    raw = {
        "id": "437123456",
        "_links": {
            "canonical": {
                "href": "https://www.realestate.com.au/property-unit-nsw-sydney-437123456"
            }
        },
        "address": {
            "display": {"fullAddress": "1 Example St, Sydney, NSW 2000"},
            "suburb": "Sydney",
            "state": "NSW",
            "postcode": "2000",
        },
        "propertyType": {"id": "unit", "display": "Unit"},
        "generalFeatures": {
            "bedrooms": {"value": 2},
            "bathrooms": {"value": 1},
            "parkingSpaces": {"value": 1},
        },
        "price": {"display": "$795 per week"},
        "availableDate": {"display": "Available now"},
        "bond": {"display": "$3,180"},
        "propertySizes": {
            "building": {"size": {"value": 82, "unit": "m²"}}
        },
        "description": "<p>Bright &amp; quiet apartment.</p>",
        "listingCompany": {"name": "Example Realty"},
        "media": {"mainImage": {"templatedUrl": "https://img/{size}/photo.jpg"}},
    }

    result = normalize_listing(raw)

    assert result.listing_id == "437123456"
    assert result.full_address == "1 Example St, Sydney, NSW 2000"
    assert result.bedrooms == 2
    assert result.weekly_rent == 795
    assert result.bond_dollars == 3180
    assert result.building_size == 82
    assert result.description == "Bright & quiet apartment."

