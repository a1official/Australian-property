"""Multi-page suburb crawl orchestrator for realestate.com.au.

Crawls sequential search result pages for a suburb/state query, extracting embedded
window.ArgonautExchange data (or rendered listings), normalizing records, and persisting
them into SQLite database tables. Supports residential proxy pools with retry and rotation.
"""

from __future__ import annotations

import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

from rea_pipeline.errors import AccessBlockedError, PipelineError
from rea_pipeline.extractor import extract_rental_search
from rea_pipeline.fetchers import load_argonaut
from rea_pipeline.normalizer import normalize_listing
from rea_pipeline.proxy import ProxyPool
from rea_pipeline.storage import (
    complete_run,
    connect,
    fail_run,
    start_run,
)


@dataclass(slots=True)
class SuburbCrawlResult:
    suburb: str
    state: str
    run_id: str
    pages_crawled: int
    total_listings_found: int
    total_listings_stored: int
    skipped_count: int
    stop_reason: str
    database: str


def build_rea_search_url(suburb: str, state: str, page: int = 1) -> str:
    """Build canonical REA search URL for suburb/state and page number."""
    suburb_slug = suburb.strip().lower().replace(" ", "+")
    state_slug = state.strip().lower()
    return f"https://www.realestate.com.au/rent/in-{suburb_slug},+{state_slug}/list-{page}"


def crawl_suburb(
    suburb: str,
    state: str,
    *,
    max_pages: int = 25,
    delay_seconds: float = 3.0,
    database: str | Path = Path("data/realstate.db"),
    proxy_pool: ProxyPool | None = None,
    max_proxy_retries: int = 3,
    timeout_seconds: float = 45.0,
    headed: bool = False,
    mode: str = "auto",
    verbose: bool = True,
) -> SuburbCrawlResult:
    """Crawl up to ``max_pages`` of rental search results for a given suburb/state."""
    run_id = str(uuid4())
    start_url = build_rea_search_url(suburb, state, page=1)
    connection = connect(database)
    start_run(connection, run_id, start_url)

    crawled_pages = 0
    total_stored = 0
    total_skipped = 0
    stop_reason = "completed"
    site_total_results = None

    try:
        for page_num in range(1, max_pages + 1):
            page_url = build_rea_search_url(suburb, state, page=page_num)
            if verbose:
                print(f"[crawl_suburb] Fetching page {page_num}/{max_pages}: {page_url}", file=sys.stderr)

            try:
                exchange, fetch_mode = load_argonaut(
                    page_url,
                    mode=mode,  # type: ignore
                    headed=headed,
                    timeout_seconds=timeout_seconds,
                    proxy_pool=proxy_pool,
                    max_proxy_retries=max_proxy_retries,
                )
                batch = extract_rental_search(exchange)
            except AccessBlockedError as exc:
                stop_reason = f"blocked_http_error ({exc})"
                if verbose:
                    print(f"[crawl_suburb] Page {page_num} blocked: {exc}", file=sys.stderr)
                break
            except PipelineError as exc:
                stop_reason = f"extraction_error ({exc})"
                if verbose:
                    print(f"[crawl_suburb] Page {page_num} extraction failed: {exc}", file=sys.stderr)
                break

            if site_total_results is None and batch.total_results is not None:
                site_total_results = batch.total_results

            normalized_listings = []
            page_skipped = 0
            for raw in batch.listings:
                try:
                    normalized_listings.append(normalize_listing(raw))
                except PipelineError:
                    page_skipped += 1

            complete_run(
                connection,
                run_id=run_id,
                fetch_mode=fetch_mode,
                batch=batch,
                listings=normalized_listings,
                skipped_count=page_skipped,
            )

            crawled_pages += 1
            total_stored += len(normalized_listings)
            total_skipped += page_skipped

            if verbose:
                print(
                    f"[crawl_suburb] Page {page_num}: stored {len(normalized_listings)} listings "
                    f"(max_page: {batch.max_page}, total: {batch.total_results})",
                    file=sys.stderr,
                )

            # Stopping condition: explicit max page reached or no more results
            if batch.more_results is False:
                stop_reason = "no_more_results"
                break
            if batch.max_page is not None and page_num >= batch.max_page:
                stop_reason = "max_site_pages_reached"
                break

            if page_num < max_pages and delay_seconds > 0:
                time.sleep(delay_seconds)

    except Exception as exc:
        fail_run(connection, run_id, str(exc))
        connection.close()
        raise

    connection.close()

    return SuburbCrawlResult(
        suburb=suburb,
        state=state,
        run_id=run_id,
        pages_crawled=crawled_pages,
        total_listings_found=site_total_results or total_stored,
        total_listings_stored=total_stored,
        skipped_count=total_skipped,
        stop_reason=stop_reason,
        database=str(Path(database).resolve()),
    )
