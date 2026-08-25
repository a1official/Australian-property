from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from uuid import uuid4

from rea_pipeline.errors import PipelineError
from rea_pipeline.extractor import extract_rental_search
from rea_pipeline.fetchers import load_argonaut
from rea_pipeline.models import RentalQuery
from rea_pipeline.normalizer import normalize_listing
from rea_pipeline.proxy import load_proxy_settings, proxy_pool_from_url
from rea_pipeline.storage import (
    complete_run,
    connect,
    fail_run,
    list_rentals,
    query_rentals,
    start_run,
)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="rea-pipeline",
        description="Ingest rental search data embedded in a loaded REA page.",
    )
    commands = parser.add_subparsers(dest="command", required=True)

    ingest = commands.add_parser("ingest", help="Fetch, normalize, and store one page")
    ingest.add_argument("source", help="HTTP(S) URL or path to saved HTML")
    ingest.add_argument(
        "--mode", choices=("auto", "http", "browser"), default="auto"
    )
    ingest.add_argument("--headed", action="store_true", help="show browser window")
    ingest.add_argument("--timeout", type=float, default=45, metavar="SECONDS")
    ingest.add_argument(
        "--database", type=Path, default=Path("data/realstate.db"), metavar="PATH"
    )
    # Proxy options
    ingest.add_argument(
        "--proxy",
        metavar="URL",
        help="single proxy URL (http://user:pass@host:port); overrides REA_PROXY_URLS env var",
    )
    ingest.add_argument(
        "--proxy-retries",
        type=int,
        default=None,
        metavar="N",
        help="max proxy rotation retries on blocked requests (default: REA_PROXY_MAX_RETRIES or 3)",
    )
    ingest.add_argument(
        "--no-proxy",
        action="store_true",
        help="disable proxy even if REA_PROXY_URLS is set in the environment",
    )

    show = commands.add_parser("list", help="Print normalized records as JSON")
    show.add_argument(
        "--database", type=Path, default=Path("data/realstate.db"), metavar="PATH"
    )
    show.add_argument("--limit", type=int, default=20)

    query = commands.add_parser(
        "query", help="Filter normalized records and print a paginated JSON result"
    )
    query.add_argument(
        "--database", type=Path, default=Path("data/realstate.db"), metavar="PATH"
    )
    query.add_argument("--source")
    query.add_argument("--text", help="search address, description, or agency")
    query.add_argument("--suburb")
    query.add_argument("--state")
    query.add_argument("--postcode")
    query.add_argument("--property-type")
    query.add_argument("--bedrooms-min", type=int)
    query.add_argument("--bedrooms-max", type=int)
    query.add_argument("--bathrooms-min", type=int)
    query.add_argument("--bathrooms-max", type=int)
    query.add_argument("--parking-min", type=int)
    query.add_argument("--weekly-rent-min", type=int)
    query.add_argument("--weekly-rent-max", type=int)
    query.add_argument(
        "--sort-by",
        choices=(
            "last_seen_at",
            "first_seen_at",
            "weekly_rent",
            "bedrooms",
            "bathrooms",
            "suburb",
        ),
        default="last_seen_at",
    )
    query.add_argument("--sort-order", choices=("asc", "desc"), default="desc")
    query.add_argument("--limit", type=int, default=20)
    query.add_argument("--offset", type=int, default=0)
    return parser


def _ingest(args: argparse.Namespace) -> int:
    # --- Proxy setup ---
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
        # honour explicit --timeout over env default
        if args.timeout != 45:
            timeout = args.timeout

    run_id = str(uuid4())
    connection = connect(args.database)
    start_run(connection, run_id, args.source)
    try:
        exchange, fetch_mode = load_argonaut(
            args.source,
            args.mode,
            headed=args.headed,
            timeout_seconds=timeout,
            proxy_pool=proxy_pool,
            max_proxy_retries=max_retries,
        )
        batch = extract_rental_search(exchange)
        normalized = []
        skipped = 0
        for raw_listing in batch.listings:
            try:
                normalized.append(normalize_listing(raw_listing))
            except PipelineError:
                skipped += 1
        complete_run(connection, run_id, fetch_mode, batch, normalized, skipped)
    except (PipelineError, OSError, ValueError) as exc:
        fail_run(connection, run_id, str(exc))
        print(f"ingestion failed: {exc}", file=sys.stderr)
        return 2
    finally:
        connection.close()

    print(
        json.dumps(
            {
                "run_id": run_id,
                "status": "completed",
                "fetch_mode": fetch_mode,
                "page_rows": len(normalized),
                "skipped_rows": skipped,
                "total_results": batch.total_results,
                "page": batch.page,
                "max_page": batch.max_page,
                "more_results": batch.more_results,
                "database": str(args.database.resolve()),
            },
            indent=2,
        )
    )
    return 0


def _list(args: argparse.Namespace) -> int:
    if args.limit < 1:
        print("--limit must be at least 1", file=sys.stderr)
        return 2
    connection = connect(args.database)
    try:
        rows = list_rentals(connection, args.limit)
    finally:
        connection.close()
    print(json.dumps(rows, ensure_ascii=False, indent=2))
    return 0


def _query(args: argparse.Namespace) -> int:
    value = RentalQuery(
        source=args.source,
        text=args.text,
        suburb=args.suburb,
        state=args.state,
        postcode=args.postcode,
        property_type=args.property_type,
        bedrooms_min=args.bedrooms_min,
        bedrooms_max=args.bedrooms_max,
        bathrooms_min=args.bathrooms_min,
        bathrooms_max=args.bathrooms_max,
        parking_min=args.parking_min,
        weekly_rent_min=args.weekly_rent_min,
        weekly_rent_max=args.weekly_rent_max,
        sort_by=args.sort_by,
        sort_order=args.sort_order,
        limit=args.limit,
        offset=args.offset,
    )
    connection = connect(args.database)
    try:
        result = query_rentals(connection, value)
    except ValueError as exc:
        print(f"invalid query: {exc}", file=sys.stderr)
        return 2
    finally:
        connection.close()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "ingest":
        return _ingest(args)
    if args.command == "list":
        return _list(args)
    return _query(args)
