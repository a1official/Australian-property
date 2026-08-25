from __future__ import annotations

import json
import re
from collections.abc import Mapping
from decimal import Decimal, ROUND_HALF_UP
from html.parser import HTMLParser
from typing import Any

from rea_pipeline.errors import ExtractionError
from rea_pipeline.models import RentalListing

_MONEY_RE = re.compile(r"\$\s*([0-9][0-9,]*(?:\.\d+)?)")


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        text = data.strip()
        if text:
            self.parts.append(text)


def _get(value: Any, *keys: str) -> Any:
    for key in keys:
        if not isinstance(value, Mapping):
            return None
        value = value.get(key)
    return value


def _text(value: Any) -> str | None:
    if isinstance(value, Mapping):
        value = value.get("display") or value.get("value") or value.get("name")
    if value is None:
        return None
    rendered = str(value).strip()
    return rendered or None


def _integer(value: Any) -> int | None:
    if isinstance(value, Mapping):
        value = value.get("value")
    if isinstance(value, bool) or value is None:
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _money_amount(value: Any) -> int | None:
    if isinstance(value, Mapping):
        raw_value = value.get("value")
        if isinstance(raw_value, (int, float)) and not isinstance(raw_value, bool):
            return int(Decimal(str(raw_value)).quantize(Decimal("1"), ROUND_HALF_UP))
        value = value.get("display")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return int(Decimal(str(value)).quantize(Decimal("1"), ROUND_HALF_UP))
    if not isinstance(value, str):
        return None
    match = _MONEY_RE.search(value)
    if not match:
        return None
    return int(Decimal(match.group(1).replace(",", "")).quantize(
        Decimal("1"), ROUND_HALF_UP
    ))


def parse_weekly_rent(price: str | None) -> int | None:
    """Convert common weekly, fortnightly, and monthly displays to $/week."""
    if not price:
        return None
    amounts = [Decimal(match.replace(",", "")) for match in _MONEY_RE.findall(price)]
    if not amounts:
        return None
    amount = sum(amounts) / len(amounts)
    lowered = price.lower()
    if "fortnight" in lowered or re.search(r"\bp/?f\b", lowered):
        amount /= Decimal(2)
    elif "month" in lowered or re.search(r"\bp/?m\b", lowered):
        amount = amount * Decimal(12) / Decimal(52)
    return int(amount.quantize(Decimal("1"), ROUND_HALF_UP))


def _plain_text(value: Any) -> str | None:
    value = _text(value)
    if value is None:
        return None
    parser = _TextExtractor()
    parser.feed(value)
    return " ".join(parser.parts) or value


def _size(value: Any) -> tuple[float | None, str | None]:
    if not isinstance(value, Mapping):
        return None, None
    nested = value.get("size")
    if isinstance(nested, Mapping):
        value = nested
    raw = value.get("value")
    try:
        numeric = float(raw) if raw is not None else None
    except (TypeError, ValueError):
        numeric = None
    return numeric, _text(value.get("unit"))


def normalize_listing(
    listing: Mapping[str, Any], source: str = "realestate.com.au"
) -> RentalListing:
    listing_id = _text(listing.get("id"))
    if listing_id is None:
        raise ExtractionError("listing is missing its stable id")

    address = listing.get("address")
    features = listing.get("generalFeatures")
    sizes = listing.get("propertySizes")
    building_size, building_unit = _size(_get(sizes, "building"))
    land_size, land_unit = _size(_get(sizes, "land"))

    price_display = _text(listing.get("price"))
    bond = listing.get("bond")
    media = listing.get("media")
    main_image = _get(media, "mainImage")
    image_url = _text(_get(main_image, "templatedUrl")) or _text(_get(main_image, "url"))

    return RentalListing(
        source=source,
        listing_id=listing_id,
        canonical_url=_text(_get(listing, "_links", "canonical", "href")),
        full_address=_text(_get(address, "display", "fullAddress"))
        or _text(_get(address, "display", "shortAddress")),
        suburb=_text(_get(address, "suburb")),
        state=_text(_get(address, "state")),
        postcode=_text(_get(address, "postcode")),
        property_type=_text(_get(listing, "propertyType", "display"))
        or _text(_get(listing, "propertyType", "id")),
        bedrooms=_integer(_get(features, "bedrooms")),
        bathrooms=_integer(_get(features, "bathrooms")),
        parking_spaces=_integer(_get(features, "parkingSpaces")),
        studies=_integer(_get(features, "studies")),
        price_display=price_display,
        weekly_rent=parse_weekly_rent(price_display),
        available_date=_text(listing.get("availableDate")),
        bond_display=_text(bond),
        bond_dollars=_money_amount(bond),
        building_size=building_size,
        building_size_unit=building_unit,
        land_size=land_size,
        land_size_unit=land_unit,
        inspections_json=json.dumps(
            listing.get("inspections") or [], ensure_ascii=False, separators=(",", ":")
        ),
        description=_plain_text(listing.get("description")),
        agency_name=_text(_get(listing, "listingCompany", "name")),
        main_image_url=image_url,
        raw_json=json.dumps(listing, ensure_ascii=False, separators=(",", ":")),
    )

