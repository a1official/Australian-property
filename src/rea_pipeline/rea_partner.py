"""REA Partner Platform Listing Export connector.

The connector uses OAuth 2.0 client credentials and imports only listings made
available to the partner by authorised REA customers. It does not scrape public
realestate.com.au pages or provide marketplace-wide search access.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

from rea_pipeline.errors import FetchError
from rea_pipeline.models import RentalListing, SearchBatch
from rea_pipeline.storage import complete_run, connect, fail_run, start_run


REA_API_ORIGIN = "https://api.realestate.com.au"
REA_TOKEN_URL = f"{REA_API_ORIGIN}/oauth/token"
REA_EXPORT_URL = f"{REA_API_ORIGIN}/listing/v1/export"
REA_SOURCE = "rea-partner"


@dataclass(slots=True, frozen=True)
class REAPartnerConfig:
    client_id: str
    client_secret: str
    agency_id: str | None = None

    @classmethod
    def from_env(cls) -> "REAPartnerConfig":
        client_id = os.getenv("REA_PARTNER_CLIENT_ID", "").strip()
        client_secret = os.getenv("REA_PARTNER_CLIENT_SECRET", "").strip()
        if not client_id or not client_secret:
            raise ValueError(
                "REA Partner credentials are not configured; set "
                "REA_PARTNER_CLIENT_ID and REA_PARTNER_CLIENT_SECRET"
            )
        return cls(
            client_id=client_id,
            client_secret=client_secret,
            agency_id=os.getenv("REA_PARTNER_AGENCY_ID", "").strip() or None,
        )


@dataclass(slots=True, frozen=True)
class REASyncResult:
    run_id: str
    imported: int
    skipped: int
    pages: int
    agency_id: str | None
    transaction_ids: tuple[str, ...]


def rea_partner_is_configured() -> bool:
    return bool(
        os.getenv("REA_PARTNER_CLIENT_ID", "").strip()
        and os.getenv("REA_PARTNER_CLIENT_SECRET", "").strip()
    )


def parse_reaxml_rentals(payload: bytes | str) -> tuple[list[RentalListing], int]:
    """Normalize current REAXML rental records into the local listing model."""
    try:
        root = ET.fromstring(payload)
    except ET.ParseError as exc:
        raise FetchError(f"REA Listing Export returned invalid XML: {exc}") from exc

    listings: list[RentalListing] = []
    skipped = 0
    for element in root:
        if _local_name(element.tag) != "rental":
            continue
        if element.attrib.get("status", "").casefold() != "current":
            continue
        try:
            listings.append(_normalize_rental(element))
        except ValueError:
            skipped += 1
    return listings, skipped


def sync_rea_listings(
    database: str | Path,
    *,
    agency_id: str | None = None,
    max_pages: int = 20,
    page_size: int = 500,
    config: REAPartnerConfig | None = None,
) -> REASyncResult:
    """Fetch and store current rentals for authorised REA agency integrations."""
    if max_pages < 1 or max_pages > 100:
        raise ValueError("max_pages must be between 1 and 100")
    if page_size < 1 or page_size > 500:
        raise ValueError("page_size must be between 1 and 500")

    settings = config or REAPartnerConfig.from_env()
    selected_agency = agency_id or settings.agency_id
    token = _get_access_token(settings)
    run_id = str(uuid4())
    source_url = f"rea-partner://agency/{selected_agency or 'authorised'}"
    connection = connect(database)
    start_run(connection, run_id, source_url)

    listings: list[RentalListing] = []
    skipped = 0
    pages = 0
    transaction_ids: list[str] = []
    next_url: str | None = _export_url(selected_agency, page_size)
    try:
        while next_url and pages < max_pages:
            xml, next_link, transaction_id = _fetch_export_page(next_url, token)
            page_listings, page_skipped = parse_reaxml_rentals(xml)
            listings.extend(page_listings)
            skipped += page_skipped
            pages += 1
            if transaction_id:
                transaction_ids.append(transaction_id)
            next_url = _safe_next_url(next_link) if next_link else None

        # A repeated listing ID is harmless; the last record in the export wins.
        deduplicated = {
            (listing.source, listing.listing_id): listing for listing in listings
        }
        normalized = list(deduplicated.values())
        batch = SearchBatch(
            listings=[],
            total_results=len(normalized),
            page=pages,
            max_page=pages if next_url is None else None,
            more_results=next_url is not None,
            resolved_query={
                "provider": "REA Partner Platform",
                "agency_id": selected_agency,
                "listing_types": ["rental"],
                "status": ["current"],
            },
        )
        complete_run(
            connection,
            run_id,
            "rea-partner-api",
            batch,
            normalized,
            skipped,
        )
        return REASyncResult(
            run_id=run_id,
            imported=len(normalized),
            skipped=skipped,
            pages=pages,
            agency_id=selected_agency,
            transaction_ids=tuple(transaction_ids),
        )
    except Exception as exc:
        fail_run(connection, run_id, str(exc))
        raise
    finally:
        connection.close()


def _get_access_token(config: REAPartnerConfig) -> str:
    body = urllib.parse.urlencode({"grant_type": "client_credentials"}).encode()
    credentials = f"{config.client_id}:{config.client_secret}"
    import base64

    request = urllib.request.Request(
        REA_TOKEN_URL,
        data=body,
        headers={
            "Authorization": "Basic " + base64.b64encode(credentials.encode()).decode(),
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
            "User-Agent": "PropertyIndex/0.1",
        },
        method="POST",
    )
    raw, _headers = _open(request, timeout=30)
    try:
        payload = json.loads(raw.decode("utf-8"))
        token = payload["access_token"]
    except (UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError) as exc:
        raise FetchError("REA OAuth response did not contain an access token") from exc
    if not isinstance(token, str) or not token:
        raise FetchError("REA OAuth response contained an invalid access token")
    return token


def _fetch_export_page(url: str, token: str) -> tuple[bytes, str | None, str | None]:
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/xml",
            "User-Agent": "PropertyIndex/0.1",
        },
    )
    raw, headers = _open(request, timeout=60)
    return raw, headers.get("x-next-link"), headers.get("x-transaction-id")


def _open(
    request: urllib.request.Request, *, timeout: float
) -> tuple[bytes, Any]:
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read(), response.headers
    except urllib.error.HTTPError as exc:
        transaction_id = exc.headers.get("x-transaction-id") if exc.headers else None
        suffix = f" (transaction {transaction_id})" if transaction_id else ""
        if exc.code == 401:
            detail = "REA rejected the OAuth credentials"
        elif exc.code == 403:
            detail = "REA has not authorised this partner or agency for Listing Export"
        elif exc.code == 429:
            detail = "REA Listing Export rate limit was exceeded"
        else:
            detail = f"REA Partner API returned HTTP {exc.code}"
        raise FetchError(detail + suffix) from exc
    except urllib.error.URLError as exc:
        raise FetchError(f"REA Partner API request failed: {exc.reason}") from exc


def _export_url(agency_id: str | None, page_size: int) -> str:
    parameters = {
        "listing_types": "rental",
        "status": "current",
        "page_size": str(page_size),
    }
    if agency_id:
        parameters["agency_id"] = agency_id
    return f"{REA_EXPORT_URL}?{urllib.parse.urlencode(parameters)}"


def _safe_next_url(value: str) -> str:
    url = urllib.parse.urljoin(REA_API_ORIGIN, value)
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.netloc != "api.realestate.com.au":
        raise FetchError("REA Listing Export returned an unsafe pagination URL")
    return url


def _normalize_rental(element: ET.Element) -> RentalListing:
    unique_id = _text(element, "uniqueID")
    if not unique_id:
        raise ValueError("rental listing has no uniqueID")

    address = _child(element, "address")
    features = _child(element, "features")
    street_number = _text(address, "streetNumber")
    sub_number = _text(address, "subNumber")
    street = _text(address, "street")
    suburb = _text(address, "suburb")
    state = _text(address, "state").upper() or None
    postcode = _text(address, "postcode") or None
    street_prefix = "/".join(part for part in (sub_number, street_number) if part)
    street_address = " ".join(part for part in (street_prefix, street) if part)
    locality = " ".join(part for part in (suburb, state, postcode) if part)
    full_address = ", ".join(part for part in (street_address, locality) if part) or None

    bedrooms_text = _text(features, "bedrooms")
    bedrooms = 0 if bedrooms_text.casefold() == "studio" else _as_int(bedrooms_text)
    bathrooms = _as_int(_text(features, "bathrooms"))
    garages = _as_int(_text(features, "garages"))
    carports = _as_int(_text(features, "carports"))
    rent = _as_int(_text(element, "rent"))
    bond = _as_int(_text(element, "bond"))
    category = _child(element, "category")
    category_name = category.attrib.get("name") if category is not None else None
    external = _child(element, "externalLink")
    canonical_url = external.attrib.get("href") if external is not None else None
    image = _main_image(element)
    agent_id = _text(element, "agentID")
    inspections = [
        child.text.strip()
        for parent in element
        if _local_name(parent.tag) == "inspectionTimes"
        for child in parent
        if _local_name(child.tag) == "inspection" and child.text and child.text.strip()
    ]
    raw = {
        "provider": "REA Partner Platform",
        "status": element.attrib.get("status"),
        "mod_time": element.attrib.get("modTime"),
        "agent_id": agent_id or None,
        "unique_id": unique_id,
    }
    return RentalListing(
        source=REA_SOURCE,
        listing_id=unique_id,
        canonical_url=canonical_url,
        full_address=full_address,
        suburb=suburb or None,
        state=state,
        postcode=postcode,
        property_type=category_name,
        bedrooms=bedrooms,
        bathrooms=bathrooms,
        parking_spaces=(
            (garages or 0) + (carports or 0)
            if garages is not None or carports is not None
            else None
        ),
        studies=1 if _text(features, "study").casefold() in {"1", "yes", "true"} else 0,
        price_display=f"${rent:,} per week" if rent is not None else None,
        weekly_rent=rent,
        available_date=_text(element, "dateAvailable") or None,
        bond_display=f"${bond:,}" if bond is not None else None,
        bond_dollars=bond,
        building_size=_area_value(element, "buildingDetails"),
        building_size_unit=_area_unit(element, "buildingDetails"),
        land_size=_area_value(element, "landDetails"),
        land_size_unit=_area_unit(element, "landDetails"),
        inspections_json=json.dumps(inspections, separators=(",", ":")),
        description=_text(element, "description") or None,
        agency_name=agent_id or None,
        main_image_url=image,
        raw_json=json.dumps(raw, separators=(",", ":")),
    )


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _child(parent: ET.Element | None, name: str) -> ET.Element | None:
    if parent is None:
        return None
    return next((item for item in parent if _local_name(item.tag) == name), None)


def _text(parent: ET.Element | None, name: str) -> str:
    child = _child(parent, name)
    return child.text.strip() if child is not None and child.text else ""


def _as_int(value: str) -> int | None:
    try:
        return int(float(value.replace(",", ""))) if value else None
    except ValueError:
        return None


def _area(parent: ET.Element, section_name: str) -> ET.Element | None:
    return _child(_child(parent, section_name), "area")


def _area_value(parent: ET.Element, section_name: str) -> float | None:
    area = _area(parent, section_name)
    try:
        return float(area.text) if area is not None and area.text else None
    except ValueError:
        return None


def _area_unit(parent: ET.Element, section_name: str) -> str | None:
    area = _area(parent, section_name)
    return area.attrib.get("unit") if area is not None else None


def _main_image(parent: ET.Element) -> str | None:
    images = _child(parent, "images")
    if images is None:
        return None
    candidates = [item for item in images if _local_name(item.tag) == "img"]
    main = next((item for item in candidates if item.attrib.get("id") == "m"), None)
    selected = main if main is not None else (candidates[0] if candidates else None)
    return selected.attrib.get("url") if selected is not None else None
