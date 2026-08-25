import pytest

from source_scrapers.errors import QueryValidationError, SourceUnavailableError
from source_scrapers.models import PropertyQuery, SourceName
from source_scrapers.rea import (
    _browser_launch_options,
    extract_rendered_listings,
    listing_matches_query,
)
from source_scrapers.registry import get_scraper


RENDERED_HTML = """
<!doctype html>
<html><body>
  <h1>2 properties for rent in Parramatta, NSW 2150</h1>
  <article data-testid="listing-card">
    <a href="/property-unit-nsw-parramatta-443000001">
      <h2 data-testid="address">10 Example Street, Parramatta NSW 2150</h2>
    </a>
    <p>$700 per week</p>
    <span aria-label="2 bedrooms">2</span>
    <span aria-label="1 bathroom">1</span>
    <span aria-label="1 car space">1</span>
    <img src="https://images.example/1.jpg" alt="property image">
  </article>
  <article data-testid="listing-card">
    <a href="https://www.realestate.com.au/property-unit-nsw-parramatta-443000002">
      <h2>20 Example Street, Parramatta NSW 2150</h2>
    </a>
    <p>$950 pw</p>
    <span aria-label="2 bedrooms">2</span>
    <span aria-label="1 bathroom">1</span>
  </article>
</body></html>
"""


def test_query_validates_ranges() -> None:
    with pytest.raises(QueryValidationError):
        PropertyQuery(suburb="Sydney", state="NSW", bedrooms_min=3, bedrooms_max=2)


def test_bs4_extracts_rendered_cards_without_page_state() -> None:
    listings, total = extract_rendered_listings(RENDERED_HTML)

    assert total == 2
    assert [item.listing_id for item in listings] == ["443000001", "443000002"]
    assert listings[0].full_address == "10 Example Street, Parramatta NSW 2150"
    assert listings[0].weekly_rent == 700
    assert listings[0].bedrooms == 2
    assert listings[0].bathrooms == 1
    assert listings[0].parking_spaces == 1
    assert "Argonaut" not in listings[0].raw_json


def test_input_filter_is_applied_to_bs4_results() -> None:
    listings, _ = extract_rendered_listings(RENDERED_HTML)
    query = PropertyQuery(
        suburb="Parramatta",
        state="NSW",
        postcode="2150",
        property_types=("apartment",),
        bedrooms_min=2,
        bathrooms_min=1,
        weekly_price_min=500,
        weekly_price_max=850,
    )

    assert [item.listing_id for item in listings if listing_matches_query(item, query)] == [
        "443000001"
    ]


def test_private_and_licensed_sources_fail_closed() -> None:
    with pytest.raises(SourceUnavailableError):
        get_scraper(SourceName.PROPERTY_TREE)


def test_google_chrome_is_a_playwright_channel() -> None:
    assert _browser_launch_options("chrome") == {"channel": "chrome"}
    assert _browser_launch_options("chromium") == {}

    with pytest.raises(ValueError):
        _browser_launch_options("firefox")
