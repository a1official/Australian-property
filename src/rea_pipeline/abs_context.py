from __future__ import annotations

import json
import re
import threading
import time
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

from bs4 import BeautifulSoup


QUICKSTATS_URL = (
    "https://www.abs.gov.au/census/find-census-data/quickstats/2021/POA{postcode}"
)
SEIFA_QUERY_URL = (
    "https://services-ap1.arcgis.com/ypkPEy1AmwPKGNNv/arcgis/rest/services/"
    "ABS_Socio_Economic_Indexes_for_Areas_SEIFA_by_2021_POA/"
    "FeatureServer/0/query"
)
SOURCE_NAME = "Australian Bureau of Statistics"
REFERENCE_PERIOD = "2021 Census"
_USER_AGENT = "RealstateMarketContext/0.1 (+local property research application)"
_CACHE_TTL_SECONDS = 24 * 60 * 60
_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_cache_lock = threading.Lock()


class ABSContextError(RuntimeError):
    """Raised when official ABS context cannot be fetched or normalized."""


TextFetcher = Callable[[str, float], str]
JsonFetcher = Callable[[str, float], dict[str, Any]]


def _request_text(url: str, timeout_seconds: float) -> str:
    request = Request(
        url,
        headers={"Accept": "text/html", "User-Agent": _USER_AGENT},
    )
    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            return response.read().decode(charset, errors="replace")
    except HTTPError as exc:
        if exc.code == 404:
            raise ABSContextError("ABS has no 2021 Postal Area data for this postcode.") from exc
        raise ABSContextError(f"ABS QuickStats returned HTTP {exc.code}.") from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise ABSContextError("ABS QuickStats is currently unavailable.") from exc


def _request_json(url: str, timeout_seconds: float) -> dict[str, Any]:
    request = Request(
        url,
        headers={"Accept": "application/json", "User-Agent": _USER_AGENT},
    )
    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            return json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        raise ABSContextError("ABS SEIFA service is currently unavailable.") from exc


def _number(value: str, *, decimal: bool = False) -> int | float | None:
    cleaned = value.replace("$", "").replace(",", "").strip()
    if not cleaned or cleaned.casefold() in {"null", "n/a", "-"}:
        return None
    match = re.search(r"-?\d+(?:\.\d+)?", cleaned)
    if not match:
        return None
    return float(match.group()) if decimal else int(float(match.group()))


def _summary_values(html: str, postcode: str) -> tuple[dict[str, str], str]:
    soup = BeautifulSoup(html, "html.parser")
    metadata = soup.select_one("script#data[type='application/json']")
    if metadata is None:
        raise ABSContextError("ABS QuickStats returned an unsupported page.")
    try:
        page = json.loads(metadata.get_text())
    except json.JSONDecodeError as exc:
        raise ABSContextError("ABS QuickStats page metadata was invalid.") from exc
    if page.get("geographyAreaCode") != f"POA{postcode}":
        raise ABSContextError("ABS QuickStats returned a different Postal Area.")

    values: dict[str, str] = {}
    for row in soup.select("table.summaryTable tr"):
        label = row.find("th")
        value = row.find("td")
        if label is not None and value is not None:
            values[label.get_text(" ", strip=True)] = value.get_text(" ", strip=True)
    required = {"People", "Median age", "All private dwellings"}
    if not required.issubset(values):
        raise ABSContextError("ABS QuickStats summary fields were incomplete.")

    title = soup.title.get_text(" ", strip=True) if soup.title else ""
    match = re.match(r"2021\s+(.+?),\s+Census", title)
    area_name = match.group(1) if match else f"Postal Area {postcode}"
    return values, area_name


def _seifa_context(
    postcode: str,
    timeout_seconds: float,
    fetch_json: JsonFetcher,
) -> dict[str, int | float | None]:
    parameters = urlencode(
        {
            "where": f"poa_code_2021 = '{postcode}'",
            "outFields": (
                "irsad_score,irsad_aus_decile,irsad_aus_percentile,"
                "irsd_score,irsd_aus_decile,irsd_aus_percentile"
            ),
            "returnGeometry": "false",
            "f": "json",
        },
        quote_via=quote,
    )
    try:
        payload = fetch_json(f"{SEIFA_QUERY_URL}?{parameters}", timeout_seconds)
    except ABSContextError:
        raise
    except (OSError, ValueError, TypeError) as exc:
        raise ABSContextError("ABS SEIFA service is currently unavailable.") from exc
    if payload.get("error"):
        raise ABSContextError("ABS SEIFA service rejected the postcode query.")
    features = payload.get("features") or []
    if not features:
        return {
            "irsad_score": None,
            "irsad_decile": None,
            "irsad_percentile": None,
            "irsd_score": None,
            "irsd_decile": None,
            "irsd_percentile": None,
        }
    attributes = features[0].get("attributes") or {}
    return {
        "irsad_score": attributes.get("irsad_score"),
        "irsad_decile": attributes.get("irsad_aus_decile"),
        "irsad_percentile": attributes.get("irsad_aus_percentile"),
        "irsd_score": attributes.get("irsd_score"),
        "irsd_decile": attributes.get("irsd_aus_decile"),
        "irsd_percentile": attributes.get("irsd_aus_percentile"),
    }


def get_abs_market_context(
    postcode: str,
    *,
    timeout_seconds: float = 15,
    fetch_text: TextFetcher = _request_text,
    fetch_json: JsonFetcher = _request_json,
    use_cache: bool = True,
) -> dict[str, Any]:
    """Return normalized, postcode-level ABS Census and SEIFA context."""

    normalized_postcode = postcode.strip()
    if not re.fullmatch(r"\d{4}", normalized_postcode):
        raise ValueError("postcode must contain exactly four digits")

    if use_cache:
        with _cache_lock:
            cached = _cache.get(normalized_postcode)
            if cached and cached[0] > time.monotonic():
                return dict(cached[1])

    source_url = QUICKSTATS_URL.format(postcode=normalized_postcode)
    values, area_name = _summary_values(
        fetch_text(source_url, timeout_seconds), normalized_postcode
    )
    try:
        seifa = _seifa_context(normalized_postcode, timeout_seconds, fetch_json)
    except ABSContextError:
        # Census context remains useful when the supplementary SEIFA service is down.
        seifa = {
            "irsad_score": None,
            "irsad_decile": None,
            "irsad_percentile": None,
            "irsd_score": None,
            "irsd_decile": None,
            "irsd_percentile": None,
        }

    result: dict[str, Any] = {
        "postcode": normalized_postcode,
        "area_name": area_name,
        "geography_type": "2021 Postal Area",
        "reference_period": REFERENCE_PERIOD,
        "population": _number(values["People"]),
        "median_age_years": _number(values["Median age"], decimal=True),
        "private_dwellings": _number(values["All private dwellings"]),
        "average_household_size": _number(
            values.get("Average number of people per household", ""), decimal=True
        ),
        "median_weekly_household_income": _number(
            values.get("Median weekly household income", "")
        ),
        "median_monthly_mortgage_repayment": _number(
            values.get("Median monthly mortgage repayments", "")
        ),
        "median_weekly_rent": _number(values.get("Median weekly rent (b)", "")),
        **seifa,
        "source": SOURCE_NAME,
        "source_url": source_url,
        "retrieved_at": datetime.now(timezone.utc),
    }
    if use_cache:
        with _cache_lock:
            _cache[normalized_postcode] = (
                time.monotonic() + _CACHE_TTL_SECONDS,
                dict(result),
            )
    return result
