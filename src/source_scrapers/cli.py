from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from uuid import uuid4

from rea_pipeline.errors import PipelineError
from rea_pipeline.models import SearchBatch
from rea_pipeline.proxy import load_proxy_settings, proxy_pool_from_url
from rea_pipeline.storage import complete_run, connect, fail_run, start_run
from source_scrapers.catalog import catalog_as_dicts
from source_scrapers.errors import SourceScraperError
from source_scrapers.models import PropertyQuery, SourceName
from source_scrapers.rea import REA_HOME_URL, REA_SOURCE_KEY
from source_scrapers.reliability import SQLiteReliabilityStore
from source_scrapers.registry import get_scraper


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="source-scraper",
        description="Run a normalized property query against one approved source adapter.",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("sources", help="Show source connector readiness")
    reliability = commands.add_parser(
        "reliability-status",
        help="Show persistent throttle/circuit state for one source",
    )
    reliability.add_argument("--source-key", default=REA_SOURCE_KEY)
    reliability.add_argument(
        "--reliability-database",
        type=Path,
        default=Path("data/source_reliability.db"),
    )

    search = commands.add_parser("search", help="Run and store a property query")
    search.add_argument("--source", choices=[item.value for item in SourceName], default=SourceName.REA.value)
    search.add_argument("--query-file", type=Path)
    search.add_argument("--suburb")
    search.add_argument("--state")
    search.add_argument("--postcode")
    search.add_argument("--property-type", action="append", dest="property_types")
    search.add_argument("--bedrooms-min", type=int)
    search.add_argument("--bedrooms-max", type=int)
    search.add_argument("--bathrooms-min", type=int)
    search.add_argument("--bathrooms-max", type=int)
    search.add_argument("--parking-min", type=int)
    search.add_argument("--weekly-price-min", type=int)
    search.add_argument("--weekly-price-max", type=int)
    search.add_argument("--radius-km", type=float, default=5.0)
    search.add_argument("--include-surrounding-suburbs", action="store_true")
    search.add_argument("--max-results", type=int, default=50)
    search.add_argument("--max-pages", type=int, default=1)
    search.add_argument("--delay", type=float, default=1.0, metavar="SECONDS")
    search.add_argument("--headed", action="store_true")
    search.add_argument(
        "--browser-channel",
        choices=("chrome", "chromium"),
        default="chrome",
        help="browser executable to launch (default: installed Google Chrome)",
    )
    search.add_argument(
        "--profile-dir",
        type=Path,
        help="dedicated Playwright user-data directory for persisted browser state",
    )
    search.add_argument("--timeout", type=float, default=45)
    search.add_argument("--input-html", help="saved HTML or archived URL for a one-page run")
    search.add_argument("--dry-run", action="store_true")
    search.add_argument("--database", type=Path, default=Path("data/realstate.db"))
    search.add_argument(
        "--reliability-database",
        type=Path,
        default=Path("data/source_reliability.db"),
        help="persistent throttle and circuit-breaker state",
    )
    search.add_argument(
        "--proxy",
        metavar="URL",
        help="single proxy URL (http://user:pass@host:port); overrides REA_PROXY_URLS env var",
    )
    search.add_argument(
        "--proxy-retries",
        type=int,
        default=None,
        metavar="N",
        help="max proxy rotation retries on blocked requests",
    )
    search.add_argument(
        "--no-proxy",
        action="store_true",
        help="disable proxy even if REA_PROXY_URLS is set in the environment",
    )
    return parser


def _load_query(args: argparse.Namespace) -> PropertyQuery:
    if args.query_file:
        try:
            payload = json.loads(args.query_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise SourceScraperError(f"could not read query file: {exc}") from exc
        if not isinstance(payload, dict):
            raise SourceScraperError("query file must contain one JSON object")
        return PropertyQuery.from_dict(payload)
    return PropertyQuery(
        suburb=args.suburb or "",
        state=args.state or "",
        postcode=args.postcode,
        property_types=tuple(args.property_types or ()),
        bedrooms_min=args.bedrooms_min,
        bedrooms_max=args.bedrooms_max,
        bathrooms_min=args.bathrooms_min,
        bathrooms_max=args.bathrooms_max,
        parking_min=args.parking_min,
        weekly_price_min=args.weekly_price_min,
        weekly_price_max=args.weekly_price_max,
        radius_km=args.radius_km,
        include_surrounding_suburbs=args.include_surrounding_suburbs,
        max_results=args.max_results,
    )


def _search(args: argparse.Namespace) -> int:
    query = _load_query(args)
    source = SourceName(args.source)
    if args.dry_run:
        entry_url = REA_HOME_URL if source == SourceName.REA else None
        print(json.dumps({
            "source": source.value,
            "query": query.to_dict(),
            "entry_url": entry_url,
            "navigation": "Playwright fills and submits the public search form",
            "extraction": "BeautifulSoup parses the rendered listing-card HTML",
            "browser_channel": args.browser_channel,
            "profile_dir": str(args.profile_dir.resolve()) if args.profile_dir else None,
            "reliability_database": str(args.reliability_database.resolve()),
        }, indent=2))
        return 0

    if args.no_proxy:
        from rea_pipeline.proxy import ProxyPool
        proxy_pool = ProxyPool()
        max_retries = 0
        timeout = args.timeout
    elif args.proxy:
        proxy_pool = proxy_pool_from_url(args.proxy)
        env_pool, env_retries, env_timeout = load_proxy_settings()
        max_retries = args.proxy_retries if args.proxy_retries is not None else env_retries
        timeout = env_timeout
    else:
        proxy_pool, max_retries, timeout = load_proxy_settings()
        if args.proxy_retries is not None:
            max_retries = args.proxy_retries
        if args.timeout != 45:
            timeout = args.timeout

    scraper = get_scraper(source)
    run_id = str(uuid4())
    source_url = args.input_html or REA_HOME_URL
    connection = connect(args.database)
    start_run(connection, run_id, source_url)
    try:
        result = scraper.search(
            query,
            headed=args.headed,
            timeout_seconds=timeout,
            max_pages=args.max_pages,
            delay_seconds=args.delay,
            source_override=args.input_html,
            browser_channel=args.browser_channel,
            profile_dir=args.profile_dir,
            reliability_database=args.reliability_database,
            proxy_pool=proxy_pool,
            max_proxy_retries=max_retries,
        )
        batch = SearchBatch(
            listings=[],
            total_results=result.site_total_results,
            page=result.pages_fetched,
            max_page=None,
            more_results=None,
            resolved_query={"requested": query.to_dict(), "site": result.site_query},
        )
        complete_run(
            connection,
            run_id,
            ",".join(dict.fromkeys(result.fetch_modes)),
            batch,
            result.listings,
            result.skipped_rows,
        )
    except (PipelineError, SourceScraperError, OSError, ValueError) as exc:
        fail_run(connection, run_id, str(exc))
        print(f"source search failed: {exc}", file=sys.stderr)
        return 2
    finally:
        connection.close()

    print(json.dumps({
        "run_id": run_id,
        "status": "completed",
        "source": source.value,
        "query": query.to_dict(),
        "source_urls": result.source_urls,
        "pages_fetched": result.pages_fetched,
        "site_total_results": result.site_total_results,
        "matching_rows": len(result.listings),
        "skipped_rows": result.skipped_rows,
        "database": str(args.database.resolve()),
    }, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "sources":
            print(json.dumps(catalog_as_dicts(), indent=2))
            return 0
        if args.command == "reliability-status":
            store = SQLiteReliabilityStore(args.reliability_database)
            print(json.dumps(store.status(args.source_key), indent=2))
            return 0
        return _search(args)
    except (SourceScraperError, ValueError) as exc:
        print(f"source search failed: {exc}", file=sys.stderr)
        return 2
