"""CLI entry-point for bulk suburb crawling with residential proxies."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from rea_pipeline.multi_page import crawl_suburb
from rea_pipeline.proxy import load_proxy_settings, proxy_pool_from_url


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="rea-bulk-crawl",
        description="Crawl and store multiple pages of rental listings for a suburb via residential proxy.",
    )
    parser.add_argument("--suburb", required=True, help="Target suburb name (e.g. Sydney, Richmond, Parramatta)")
    parser.add_argument("--state", required=True, help="Target state code (e.g. NSW, VIC, QLD)")
    parser.add_argument("--max-pages", type=int, default=25, help="Maximum search result pages to crawl (default: 25)")
    parser.add_argument("--delay-seconds", type=float, default=3.0, help="Delay between page requests in seconds")
    parser.add_argument("--mode", choices=("auto", "http", "browser"), default="auto", help="Fetch mode")
    parser.add_argument("--headed", action="store_true", help="Show browser window if browser mode is used")
    parser.add_argument("--timeout", type=float, default=45.0, help="Per-request timeout in seconds")
    parser.add_argument("--database", type=Path, default=Path("data/realstate.db"), help="Target SQLite database path")

    # Proxy controls
    parser.add_argument(
        "--proxy",
        metavar="URL",
        help="single proxy URL (http://user:pass@host:port); overrides REA_PROXY_URLS env var",
    )
    parser.add_argument(
        "--proxy-retries",
        type=int,
        default=None,
        metavar="N",
        help="max proxy rotation retries on blocked requests",
    )
    parser.add_argument(
        "--no-proxy",
        action="store_true",
        help="disable proxy even if REA_PROXY_URLS is set in environment",
    )
    parser.add_argument("--quiet", action="store_true", help="Suppress progress output")

    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)

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
        if args.timeout != 45.0:
            timeout = args.timeout

    try:
        res = crawl_suburb(
            suburb=args.suburb,
            state=args.state,
            max_pages=args.max_pages,
            delay_seconds=args.delay_seconds,
            database=args.database,
            proxy_pool=proxy_pool,
            max_proxy_retries=max_retries,
            timeout_seconds=timeout,
            headed=args.headed,
            mode=args.mode,
            verbose=not args.quiet,
        )
        print(
            json.dumps(
                {
                    "status": "completed",
                    "run_id": res.run_id,
                    "suburb": res.suburb,
                    "state": res.state,
                    "pages_crawled": res.pages_crawled,
                    "listings_stored": res.total_listings_stored,
                    "skipped_count": res.skipped_count,
                    "stop_reason": res.stop_reason,
                    "database": res.database,
                },
                indent=2,
            )
        )
        return 0
    except Exception as exc:
        print(f"bulk crawl failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
