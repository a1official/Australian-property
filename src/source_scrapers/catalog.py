from __future__ import annotations

from dataclasses import asdict, dataclass

from source_scrapers.models import SourceName


@dataclass(frozen=True, slots=True)
class SourceCapability:
    source: SourceName
    data: str
    connector: str
    ready: bool
    note: str


SOURCE_CATALOG = (
    SourceCapability(
        SourceName.REA,
        "active rental listings and advertised rents",
        "Playwright public search UI followed by BeautifulSoup rendered-card parsing",
        True,
        "No internal endpoint, response interception, or ArgonautExchange extraction.",
    ),
    SourceCapability(
        SourceName.PROPERTY_TREE,
        "tenant, ledger, maintenance, and inspection records",
        "authorised MRI API or customer export",
        False,
        "Requires the team's API/export contract and field mapping; never public-page scraping.",
    ),
    SourceCapability(
        SourceName.RP_DATA,
        "property attributes, valuations, sales, and market history",
        "licensed API or export",
        False,
        "Requires licensed endpoint/export documentation and credentials.",
    ),
    SourceCapability(
        SourceName.PRICEFINDER,
        "sold and leased comparables",
        "licensed API or export",
        False,
        "Requires licensed endpoint/export documentation and credentials.",
    ),
    SourceCapability(
        SourceName.SUPPLEMENTARY,
        "supplementary comparable records",
        "provider-specific authorised API/export",
        False,
        "Exact eKnights/provider identity and contract are still unconfirmed.",
    ),
)


def catalog_as_dicts() -> list[dict[str, object]]:
    rows = []
    for item in SOURCE_CATALOG:
        row = asdict(item)
        row["source"] = item.source.value
        rows.append(row)
    return rows
