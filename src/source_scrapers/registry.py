from source_scrapers.errors import SourceUnavailableError
from source_scrapers.models import SourceName
from source_scrapers.rea import RealEstateAuScraper


def get_scraper(source: SourceName):
    if source == SourceName.REA:
        return RealEstateAuScraper()
    raise SourceUnavailableError(
        f"{source.value} requires an authorised API/export connector and its "
        "field mapping; no public-page scraper is enabled for this source"
    )
