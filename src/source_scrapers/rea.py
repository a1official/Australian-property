from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup, Tag

from rea_pipeline.errors import AccessBlockedError, ExtractionError, FetchError
from rea_pipeline.models import RentalListing
from rea_pipeline.normalizer import parse_weekly_rent
from rea_pipeline.proxy import ProxyConfig, ProxyPool
from source_scrapers.models import PropertyQuery, SourceName, SourceResult
from source_scrapers.reliability import (
    ReliabilityPolicy,
    SQLiteReliabilityStore,
    parse_retry_after,
)


REA_HOME_URL = "https://www.realestate.com.au/"
REA_SOURCE_KEY = "realestate.com.au:public-ui"
SUPPORTED_BROWSER_CHANNELS = ("chrome", "chromium")

_PROPERTY_TYPE_ALIASES = {
    "apartment": "unit",
    "apartments": "unit",
    "flat": "unit",
    "flats": "unit",
    "units": "unit",
    "townhouses": "townhouse",
    "houses": "house",
}
_PROPERTY_URL_RE = re.compile(
    r"/property-(?P<property_type>[a-z0-9+%_-]+)-"
    r"(?P<state>act|nsw|nt|qld|sa|tas|vic|wa)-"
    r"(?P<suburb>.+)-(?P<listing_id>\d+)(?:[/?#]|$)",
    re.IGNORECASE,
)
_POSTCODE_RE = re.compile(
    r"\b(ACT|NSW|NT|QLD|SA|TAS|VIC|WA)\s+(\d{4})\b", re.IGNORECASE
)
_PRICE_RE = re.compile(
    r"\$\s*[0-9][0-9,]*(?:\.\d+)?"
    r"(?:\s*[-–]\s*\$?\s*[0-9][0-9,]*(?:\.\d+)?)?"
    r"(?:\s*(?:per\s+week|p/?w|weekly))?",
    re.IGNORECASE,
)
_FEATURE_PATTERNS = {
    "bedrooms": re.compile(r"\b(\d+)\s*(?:bed|beds|bedroom|bedrooms)\b", re.I),
    "bathrooms": re.compile(r"\b(\d+)\s*(?:bath|baths|bathroom|bathrooms)\b", re.I),
    "parking": re.compile(
        r"\b(\d+)\s*(?:car|cars|carspace|carspaces|parking|garage)\b", re.I
    ),
}


def _canonical_property_type(value: str | None) -> str | None:
    if not value:
        return None
    normalized = value.strip().lower().replace(" ", "_")
    return _PROPERTY_TYPE_ALIASES.get(normalized, normalized)


def _integer_match(pattern: re.Pattern[str], value: str) -> int | None:
    match = pattern.search(value)
    return int(match.group(1)) if match else None


def _attribute_text(card: Tag) -> str:
    values: list[str] = []
    for element in card.find_all(True):
        for name in ("aria-label", "title", "alt"):
            value = element.get(name)
            if isinstance(value, str) and value.strip():
                values.append(value.strip())
    visible = card.get_text(" ", strip=True)
    return " ".join([visible, *values])


def _listing_container(link: Tag) -> Tag:
    for parent in link.parents:
        if not isinstance(parent, Tag):
            continue
        test_id = str(parent.get("data-testid") or "").lower()
        if parent.name == "article" or "listing" in test_id or "property-card" in test_id:
            return parent
        if parent.name == "li" and len(parent.get_text(" ", strip=True)) < 5000:
            return parent
    return link


def _address(card: Tag, link: Tag) -> str | None:
    selectors = (
        '[data-testid*="address" i]',
        '[class*="address" i]',
        "h2",
        "h3",
    )
    for selector in selectors:
        candidate = card.select_one(selector)
        if candidate:
            text = candidate.get_text(" ", strip=True)
            if text:
                return text
    text = link.get_text(" ", strip=True)
    return text or None


def _extract_total_results(soup: BeautifulSoup) -> int | None:
    text = soup.get_text(" ", strip=True)
    patterns = (
        re.compile(r"\b([0-9][0-9,]*)\s+properties\s+for\s+rent\b", re.I),
        re.compile(r"\b([0-9][0-9,]*)\s+rental\s+properties\b", re.I),
    )
    for pattern in patterns:
        match = pattern.search(text)
        if match:
            return int(match.group(1).replace(",", ""))
    return None


def extract_rendered_listings(html: str) -> tuple[list[RentalListing], int | None]:
    """Extract visible listing-card data from Playwright-rendered HTML with BS4."""
    soup = BeautifulSoup(html, "html.parser")
    listings: list[RentalListing] = []
    seen: set[str] = set()

    for link in soup.select('a[href*="/property-"]'):
        href = link.get("href")
        if not isinstance(href, str):
            continue
        match = _PROPERTY_URL_RE.search(urlparse(href).path)
        if not match:
            continue
        listing_id = match.group("listing_id")
        if listing_id in seen:
            continue

        card = _listing_container(link)
        searchable_text = _attribute_text(card)
        price_match = _PRICE_RE.search(searchable_text)
        price_display = price_match.group(0).strip() if price_match else None
        postcode_match = _POSTCODE_RE.search(searchable_text)
        postcode = postcode_match.group(2) if postcode_match else None
        image = card.select_one("img[src], img[data-src]")
        image_url = None
        if image:
            candidate = image.get("src") or image.get("data-src")
            image_url = str(candidate) if candidate else None

        property_type = match.group("property_type").replace("+", " ").replace("%20", " ")
        raw = {
            "extraction": "rendered_listing_card",
            "card_text": card.get_text(" ", strip=True),
        }
        listings.append(
            RentalListing(
                source=SourceName.REA.value,
                listing_id=listing_id,
                canonical_url=urljoin(REA_HOME_URL, href),
                full_address=_address(card, link),
                suburb=match.group("suburb").replace("+", " ").replace("%20", " ").title(),
                state=match.group("state").upper(),
                postcode=postcode,
                property_type=property_type,
                bedrooms=_integer_match(_FEATURE_PATTERNS["bedrooms"], searchable_text),
                bathrooms=_integer_match(_FEATURE_PATTERNS["bathrooms"], searchable_text),
                parking_spaces=_integer_match(_FEATURE_PATTERNS["parking"], searchable_text),
                studies=None,
                price_display=price_display,
                weekly_rent=parse_weekly_rent(price_display),
                available_date=None,
                bond_display=None,
                bond_dollars=None,
                building_size=None,
                building_size_unit=None,
                land_size=None,
                land_size_unit=None,
                inspections_json="[]",
                description=None,
                agency_name=None,
                main_image_url=image_url,
                raw_json=json.dumps(raw, ensure_ascii=False, separators=(",", ":")),
            )
        )
        seen.add(listing_id)
    return listings, _extract_total_results(soup)


def listing_matches_query(listing: RentalListing, query: PropertyQuery) -> bool:
    if listing.state and listing.state.casefold() != query.state.casefold():
        return False
    if not query.include_surrounding_suburbs:
        if listing.suburb and listing.suburb.casefold() != query.suburb.casefold():
            return False
        if query.postcode and listing.postcode and listing.postcode != query.postcode:
            return False

    requested_types = {
        _canonical_property_type(value) for value in query.property_types if value.strip()
    }
    if requested_types and _canonical_property_type(listing.property_type) not in requested_types:
        return False

    comparisons = (
        (listing.bedrooms, query.bedrooms_min, "min"),
        (listing.bedrooms, query.bedrooms_max, "max"),
        (listing.bathrooms, query.bathrooms_min, "min"),
        (listing.bathrooms, query.bathrooms_max, "max"),
        (listing.parking_spaces, query.parking_min, "min"),
        (listing.weekly_rent, query.weekly_price_min, "min"),
        (listing.weekly_rent, query.weekly_price_max, "max"),
    )
    for actual, expected, operation in comparisons:
        if expected is None:
            continue
        if actual is None:
            return False
        if operation == "min" and actual < expected:
            return False
        if operation == "max" and actual > expected:
            return False
    return True


def _first_visible(locator):
    for index in range(locator.count()):
        candidate = locator.nth(index)
        if candidate.is_visible():
            return candidate
    return None


def _browser_launch_options(browser_channel: str) -> dict[str, str]:
    """Translate the public browser choice into Playwright launch options."""
    normalized = browser_channel.strip().lower()
    if normalized not in SUPPORTED_BROWSER_CHANNELS:
        supported = ", ".join(SUPPORTED_BROWSER_CHANNELS)
        raise ValueError(f"browser_channel must be one of: {supported}")
    return {"channel": "chrome"} if normalized == "chrome" else {}


def _dismiss_cookie_prompt(page) -> None:
    for label in ("Accept all", "Accept", "I agree"):
        button = _first_visible(page.get_by_role("button", name=re.compile(f"^{label}$", re.I)))
        if button is not None:
            button.click()
            return


def _submit_query_through_ui(page, query: PropertyQuery, timeout_ms: float) -> None:
    _dismiss_cookie_prompt(page)
    rent_controls = page.get_by_role(
        "tab", name=re.compile(r"^rent$", re.I)
    ).or_(page.get_by_role("button", name=re.compile(r"^rent$", re.I))).or_(
        page.get_by_role("link", name=re.compile(r"^rent$", re.I))
    )
    rent = _first_visible(rent_controls)
    if rent is not None:
        rent.click()

    inputs = page.locator(
        'input[placeholder*="suburb" i], input[placeholder*="postcode" i], '
        'input[aria-label*="suburb" i], input[aria-label*="postcode" i]'
    )
    search_input = _first_visible(inputs)
    if search_input is None:
        raise ExtractionError("could not find the public property-location search box")

    location = ", ".join(part for part in (query.suburb, query.state) if part)
    if query.postcode:
        location += f" {query.postcode}"
    search_input.fill(location)
    page.wait_for_timeout(750)

    option = _first_visible(page.get_by_role("option"))
    if option is not None:
        option.click()
    else:
        search_input.press("Enter")

    search_button = _first_visible(
        page.get_by_role("button", name=re.compile(r"^(search|find properties)$", re.I))
    )
    if search_button is not None and "/rent/" not in page.url:
        search_button.click()

    try:
        page.wait_for_url(re.compile(r"/rent/"), timeout=timeout_ms)
    except Exception:
        # The results can update in-place; the rendered-card wait below is authoritative.
        pass
    page.wait_for_load_state("domcontentloaded", timeout=timeout_ms)
    try:
        page.locator('a[href*="/property-"]').first.wait_for(
            state="attached", timeout=timeout_ms
        )
    except Exception:
        body = page.locator("body").inner_text().casefold()
        if not any(text in body for text in ("no properties", "0 properties")):
            raise ExtractionError(
                "the results page did not render any recognizable property cards"
            )


class RealEstateAuScraper:
    """Use Playwright UI actions, then parse only rendered HTML with BeautifulSoup."""

    source = SourceName.REA

    def search(
        self,
        query: PropertyQuery,
        *,
        headed: bool = False,
        timeout_seconds: float = 45,
        max_pages: int = 1,
        delay_seconds: float = 1.0,
        source_override: str | None = None,
        browser_channel: str = "chrome",
        profile_dir: str | Path | None = None,
        reliability_database: str | Path | None = Path("data/source_reliability.db"),
        proxy_pool: ProxyPool | None = None,
        max_proxy_retries: int = 3,
        **_: Any,
    ) -> SourceResult:
        if max_pages < 1 or max_pages > 50:
            raise ValueError("max_pages must be between 1 and 50")
        if delay_seconds < 0:
            raise ValueError("delay_seconds cannot be negative")
        launch_options = _browser_launch_options(browser_channel)

        if source_override:
            path = Path(source_override).expanduser()
            if not path.is_file():
                raise FetchError("--input-html must be a local rendered HTML file")
            html = path.read_text(encoding="utf-8", errors="replace")
            extracted, total = extract_rendered_listings(html)
            matches = [item for item in extracted if listing_matches_query(item, query)]
            return SourceResult(
                source=self.source,
                query=query,
                listings=matches[: query.max_results],
                source_urls=[str(path.resolve())],
                fetch_modes=["rendered-html-fixture"],
                pages_fetched=1,
                site_total_results=total,
                site_query={"navigation": "offline rendered HTML", "parser": "BeautifulSoup"},
            )

        try:
            from playwright.sync_api import sync_playwright  # noqa: F401
        except ImportError as exc:
            raise FetchError(
                'browser scraper requires: pip install -e ".[browser]"; install '
                "Google Chrome for --browser-channel chrome, or run "
                "playwright install chromium for --browser-channel chromium"
            ) from exc

        reliability_store = (
            SQLiteReliabilityStore(reliability_database)
            if reliability_database is not None
            else None
        )
        # REA refusals are never retried — one refusal opens a long cooling-off
        # circuit so scheduled jobs cannot hammer the public website.
        reliability_policy = ReliabilityPolicy(
            min_interval_seconds=30,
            max_retries=0,
            circuit_failure_threshold=1,
            circuit_cooldown_seconds=24 * 60 * 60,
            cache_ttl_seconds=0,
        )
        if reliability_store is not None:
            reliability_store.before_request(REA_SOURCE_KEY, reliability_policy)

        # Build proxy retry sequence: first attempt with no proxy, then rotate.
        proxy_attempts: list[ProxyConfig | None]
        if proxy_pool and not proxy_pool.is_empty:
            proxy_attempts = [None] + proxy_pool.pick_sequence(max_proxy_retries)
        else:
            proxy_attempts = [None]

        last_access_error: AccessBlockedError | None = None

        for attempt_index, proxy_cfg in enumerate(proxy_attempts):
            try:
                result = self._search_once(
                    query=query,
                    headed=headed,
                    timeout_seconds=timeout_seconds,
                    max_pages=max_pages,
                    delay_seconds=delay_seconds,
                    launch_options=launch_options,
                    profile_dir=profile_dir,
                    reliability_store=reliability_store,
                    reliability_policy=reliability_policy,
                    proxy_cfg=proxy_cfg,
                )
                if reliability_store is not None:
                    reliability_store.record_success(REA_SOURCE_KEY, status=200)
                return result
            except AccessBlockedError as exc:
                last_access_error = exc
                if attempt_index < len(proxy_attempts) - 1:
                    next_proxy = proxy_attempts[attempt_index + 1]
                    label = next_proxy.server_url if next_proxy else "no proxy"
                    import sys
                    print(
                        f"[proxy] blocked (attempt {attempt_index + 1}), "
                        f"retrying via {label}",
                        file=sys.stderr,
                    )
                continue

        assert last_access_error is not None
        raise last_access_error

    def _search_once(
        self,
        *,
        query: PropertyQuery,
        headed: bool,
        timeout_seconds: float,
        max_pages: int,
        delay_seconds: float,
        launch_options: dict[str, str],
        profile_dir: str | Path | None,
        reliability_store: SQLiteReliabilityStore | None,
        reliability_policy: ReliabilityPolicy,
        proxy_cfg: ProxyConfig | None,
    ) -> SourceResult:
        import sys as _sys
        from playwright.sync_api import Error as PlaywrightError
        from playwright.sync_api import sync_playwright

        timeout_ms = timeout_seconds * 1000
        matches: list[RentalListing] = []
        seen: set[str] = set()
        urls: list[str] = []
        site_total: int | None = None

        # Build context proxy kwargs
        context_kwargs: dict[str, Any] = {}
        if proxy_cfg is not None:
            context_kwargs["proxy"] = proxy_cfg.playwright_proxy()
            print(f"[proxy] playwright → {proxy_cfg.server_url}", file=_sys.stderr)

        request_lease: str | None = None
        if reliability_store is not None:
            request_lease = reliability_store.acquire_request_slot(
                REA_SOURCE_KEY, reliability_policy
            )

        try:
            with sync_playwright() as playwright:
                browser = None
                context = None
                try:
                    if profile_dir:
                        persistent_profile = Path(profile_dir).expanduser()
                        persistent_profile.mkdir(parents=True, exist_ok=True)
                        context = playwright.chromium.launch_persistent_context(
                            str(persistent_profile.resolve()),
                            headless=not headed,
                            **launch_options,
                            **context_kwargs,
                        )
                        page = context.pages[0] if context.pages else context.new_page()
                    else:
                        browser = playwright.chromium.launch(
                            headless=not headed,
                            **launch_options,
                        )
                        context = browser.new_context(**context_kwargs)
                        page = context.new_page()

                    response = page.goto(
                        REA_HOME_URL,
                        wait_until="domcontentloaded",
                        timeout=timeout_ms,
                    )
                    status = response.status if response else None
                    if status in {401, 403, 429}:
                        retry_after = parse_retry_after(
                            response.headers.get("retry-after") if response else None
                        )
                        if reliability_store is not None:
                            reliability_store.record_failure(
                                REA_SOURCE_KEY,
                                reliability_policy,
                                status=status,
                                error=f"source refusal HTTP {status}",
                                retry_after_seconds=retry_after,
                            )
                        raise AccessBlockedError(
                            f"source refused the browser page with status {status}"
                        )
                    _submit_query_through_ui(page, query, timeout_ms)

                    for page_number in range(1, max_pages + 1):
                        html = page.content()
                        extracted, page_total = extract_rendered_listings(html)
                        site_total = page_total if page_total is not None else site_total
                        urls.append(page.url)
                        for listing in extracted:
                            if listing.listing_id in seen:
                                continue
                            seen.add(listing.listing_id)
                            if listing_matches_query(listing, query):
                                matches.append(listing)
                            if len(matches) >= query.max_results:
                                break
                        if len(matches) >= query.max_results or page_number >= max_pages:
                            break

                        next_button = _first_visible(
                            page.get_by_role(
                                "link", name=re.compile(r"^(next|next page)$", re.I)
                            ).or_(page.get_by_role(
                                "button", name=re.compile(r"^(next|next page)$", re.I)
                            ))
                        )
                        if next_button is None or next_button.is_disabled():
                            break
                        next_button.click()
                        page.wait_for_timeout(max(250, int(delay_seconds * 1000)))
                        page.wait_for_load_state("domcontentloaded", timeout=timeout_ms)
                finally:
                    if context is not None:
                        context.close()
                    if browser is not None:
                        browser.close()
        except AccessBlockedError:
            raise
        except PlaywrightError as exc:
            raise FetchError(f"browser UI collection failed: {exc}") from exc
        finally:
            if reliability_store is not None and request_lease is not None:
                reliability_store.release_request_slot(request_lease)

        return SourceResult(
            source=self.source,
            query=query,
            listings=matches,
            source_urls=urls,
            fetch_modes=["playwright-ui+beautifulsoup"] * len(urls),
            pages_fetched=len(urls),
            site_total_results=site_total,
            site_query={
                "navigation": "Playwright public search UI",
                "parser": "BeautifulSoup rendered listing cards",
                "proxy": proxy_cfg.server_url if proxy_cfg else None,
                "persistent_profile": bool(profile_dir),
            },
        )
