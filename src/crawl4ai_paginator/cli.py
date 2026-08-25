from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urldefrag, urljoin, urlsplit

from bs4 import BeautifulSoup

from rea_pipeline.proxy import ProxyConfig, load_proxy_settings, proxy_pool_from_url


@dataclass(slots=True)
class FetchedPage:
    requested_url: str
    final_url: str
    success: bool
    status_code: int | None
    title: str | None
    markdown: str
    html: str
    internal_links: list[dict[str, str | None]]
    external_link_count: int
    error: str | None = None


FetchPage = Callable[[str], Awaitable[FetchedPage]]


def find_next_url(
    current_url: str,
    html: str,
    internal_links: list[dict[str, str | None]] | None = None,
    *,
    selector: str | None = None,
) -> str | None:
    """Find an explicit same-origin Next link in rendered HTML or link metadata."""
    soup = BeautifulSoup(html or "", "html.parser")
    candidates: list[str] = []

    if selector:
        node = soup.select_one(selector)
        if node and node.get("href"):
            candidates.append(str(node["href"]))

    for node in soup.select('link[rel~="next"][href], a[rel~="next"][href]'):
        candidates.append(str(node["href"]))

    next_labels = {
        "next",
        "next page",
        "older",
        "older posts",
        ">",
        "›",
        "→",
    }
    for node in soup.select("a[href]"):
        labels = (
            node.get_text(" ", strip=True),
            node.get("aria-label"),
            node.get("title"),
        )
        if any(_normalize_label(label) in next_labels for label in labels if label):
            candidates.append(str(node["href"]))

    for link in internal_links or []:
        labels = (link.get("text"), link.get("title"))
        if any(_normalize_label(label) in next_labels for label in labels if label):
            href = link.get("href")
            if href:
                candidates.append(href)

    for candidate in candidates:
        if candidate.startswith(("javascript:", "tel:", "mailto:")) or candidate == "#":
            continue
        resolved, _ = urldefrag(urljoin(current_url, candidate))
        if _same_origin(current_url, resolved) and resolved != current_url:
            return resolved
    return None


async def paginate_pages(
    start_url: str,
    fetch_page: FetchPage,
    *,
    max_pages: int = 20,
    delay_seconds: float = 2.0,
    next_selector: str | None = None,
    include_html: bool = False,
) -> dict[str, Any]:
    """Follow explicit Next links until exhaustion or a safety stop."""
    if max_pages < 1:
        raise ValueError("max_pages must be at least 1")
    if delay_seconds < 0:
        raise ValueError("delay_seconds cannot be negative")

    current_url = _validate_url(start_url)
    visited_urls: set[str] = set()
    content_hashes: set[str] = set()
    pages: list[dict[str, Any]] = []
    stop_reason = "max_pages_reached"

    for page_number in range(1, max_pages + 1):
        if current_url in visited_urls:
            stop_reason = "repeated_url"
            break
        visited_urls.add(current_url)

        fetched = await fetch_page(current_url)
        record = _page_record(fetched, page_number, include_html=include_html)
        if not fetched.success or (
            fetched.status_code is not None and fetched.status_code >= 400
        ):
            pages.append(record)
            stop_reason = "crawl_error"
            break

        fingerprint_source = fetched.html or fetched.markdown
        fingerprint = hashlib.sha256(
            fingerprint_source.encode("utf-8", errors="replace")
        ).hexdigest()
        if fingerprint in content_hashes:
            stop_reason = "repeated_content"
            break
        content_hashes.add(fingerprint)

        next_url = find_next_url(
            fetched.final_url,
            fetched.html,
            fetched.internal_links,
            selector=next_selector,
        )
        record["next_url"] = next_url
        pages.append(record)

        if next_url is None:
            stop_reason = "next_link_not_found"
            break
        if next_url in visited_urls:
            stop_reason = "repeated_url"
            break
        if page_number == max_pages:
            stop_reason = "max_pages_reached"
            break

        if delay_seconds:
            await asyncio.sleep(delay_seconds)
        current_url = next_url

    return {
        "schema_version": 1,
        "start_url": start_url,
        "crawled_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "page_count": len(pages),
        "max_pages": max_pages,
        "stop_reason": stop_reason,
        "pages": pages,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="crawl4ai-paginate",
        description=(
            "Follow explicit same-origin Next links and store Crawl4AI results "
            "in one JSON file. Use only with an authorized source."
        ),
    )
    parser.add_argument("url", help="authorized starting HTTP(S) URL")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("data/source-crawl.json"),
        metavar="PATH",
    )
    parser.add_argument("--max-pages", type=int, default=20)
    parser.add_argument("--delay-seconds", type=float, default=2.0)
    parser.add_argument(
        "--next-selector",
        help="optional CSS selector for the source's Next link",
    )
    parser.add_argument(
        "--include-html",
        action="store_true",
        help="include rendered HTML in the JSON output",
    )
    
    # New Stealth & Anti-Bot Arguments
    parser.add_argument(
        "--enable-stealth",
        action="store_true",
        help="Enable playwright-stealth modifications to bypass bot detection",
    )
    parser.add_argument(
        "--magic",
        action="store_true",
        help="Enable Crawl4AI magic mode (pop-ups handling, stealth adjustments)",
    )
    parser.add_argument(
        "--simulate-user",
        action="store_true",
        help="Simulate human-like behavior (mouse movements/random delays)",
    )
    parser.add_argument(
        "--override-navigator",
        action="store_true",
        help="Override navigator properties via JS to hide automation footprint",
    )

    parser.add_argument(
        "--authorized",
        action="store_true",
        help="confirm permission to automate a non-local source",
    )
    parser.add_argument("--timeout", type=float, default=60.0, metavar="SECONDS")
    parser.add_argument("--verbose", action="store_true")

    # Proxy options
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
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        url = _validate_url(args.url)
    except ValueError as exc:
        print(f"invalid URL: {exc}", file=sys.stderr)
        return 2
    if not _is_local_url(url) and not args.authorized:
        print(
            "refusing remote crawl: pass --authorized only after confirming the "
            "source permits automated access",
            file=sys.stderr,
        )
        return 2
    if not 1 <= args.max_pages <= 1000:
        print("--max-pages must be between 1 and 1000", file=sys.stderr)
        return 2
    if args.delay_seconds < 0:
        print("--delay-seconds cannot be negative", file=sys.stderr)
        return 2
    if args.timeout <= 0:
        print("--timeout must be positive", file=sys.stderr)
        return 2

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
        if args.timeout != 60.0:
            timeout = args.timeout

    try:
        result = asyncio.run(
            _crawl_with_crawl4ai(
                url,
                max_pages=args.max_pages,
                delay_seconds=args.delay_seconds,
                next_selector=args.next_selector,
                include_html=args.include_html,
                timeout_seconds=timeout,
                verbose=args.verbose,
                enable_stealth=args.enable_stealth,
                magic=args.magic,
                simulate_user=args.simulate_user,
                override_navigator=args.override_navigator,
                proxy_pool=proxy_pool,
                max_proxy_retries=max_retries,
            )
        )
        _write_json(args.output, result)
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"pagination failed: {exc}", file=sys.stderr)
        return 1

    print(
        json.dumps(
            {
                "status": "completed",
                "page_count": result["page_count"],
                "stop_reason": result["stop_reason"],
                "output": str(args.output.resolve()),
            },
            indent=2,
        )
    )
    return 0


async def _crawl_with_crawl4ai(
    start_url: str,
    *,
    max_pages: int,
    delay_seconds: float,
    next_selector: str | None,
    include_html: bool,
    timeout_seconds: float,
    verbose: bool,
    enable_stealth: bool,
    magic: bool,
    simulate_user: bool,
    override_navigator: bool,
    proxy_pool: ProxyPool | None = None,
    max_proxy_retries: int = 3,
) -> dict[str, Any]:
    try:
        from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig
    except ImportError as exc:
        raise RuntimeError(
            'Crawl4AI is not installed; run: pip install -e ".[crawl4ai]"'
        ) from exc

    proxy_attempts: list[ProxyConfig | None]
    if proxy_pool and not proxy_pool.is_empty:
        proxy_attempts = [None] + proxy_pool.pick_sequence(max_proxy_retries)
    else:
        proxy_attempts = [None]

    last_exc: Exception | None = None

    for attempt_index, proxy in enumerate(proxy_attempts):
        browser_kwargs: dict[str, Any] = {
            "headless": True,
            "verbose": verbose,
            "enable_stealth": enable_stealth,
        }
        if proxy is not None:
            browser_kwargs["proxy_config"] = proxy.crawl4ai_proxy()
            print(f"[proxy] crawl4ai → {proxy.server_url}", file=sys.stderr)

        browser_config = BrowserConfig(**browser_kwargs)
        run_config = CrawlerRunConfig(
            cache_mode=CacheMode.BYPASS,
            check_robots_txt=True,
            page_timeout=int(timeout_seconds * 1000),
            verbose=verbose,
            magic=magic,
            simulate_user=simulate_user,
            override_navigator=override_navigator,
        )

        try:
            async with AsyncWebCrawler(config=browser_config) as crawler:

                async def fetch_page(url: str) -> FetchedPage:
                    result = await crawler.arun(url=url, config=run_config)
                    markdown_value = result.markdown
                    markdown = getattr(markdown_value, "raw_markdown", None) or str(
                        markdown_value or ""
                    )
                    metadata = result.metadata or {}
                    internal_links = [
                        {
                            "href": _string_or_none(link.get("href")),
                            "text": _string_or_none(link.get("text")),
                            "title": _string_or_none(link.get("title")),
                        }
                        for link in (result.links or {}).get("internal", [])
                        if link.get("href")
                    ]
                    final_url = result.redirected_url or result.url or url
                    return FetchedPage(
                        requested_url=url,
                        final_url=final_url,
                        success=bool(result.success),
                        status_code=result.status_code,
                        title=_string_or_none(metadata.get("title")),
                        markdown=markdown,
                        html=result.html or "",
                        internal_links=internal_links,
                        external_link_count=len((result.links or {}).get("external", [])),
                        error=_string_or_none(result.error_message),
                    )

                res = await paginate_pages(
                    start_url,
                    fetch_page,
                    max_pages=max_pages,
                    delay_seconds=delay_seconds,
                    next_selector=next_selector,
                    include_html=include_html,
                )
                if res.get("stop_reason") == "crawl_error":
                    first_page_err = (res.get("pages") or [{}])[0].get("error") or ""
                    if "429" in first_page_err or "403" in first_page_err or "Blocked" in first_page_err:
                        raise RuntimeError(f"crawl blocked: {first_page_err}")
                return res
        except RuntimeError as exc:
            last_exc = exc
            if attempt_index < len(proxy_attempts) - 1:
                next_proxy = proxy_attempts[attempt_index + 1]
                label = next_proxy.server_url if next_proxy else "no proxy"
                print(f"[proxy] blocked (attempt {attempt_index + 1}), retrying via {label}", file=sys.stderr)
            continue

    assert last_exc is not None
    raise last_exc


def _page_record(
    page: FetchedPage, page_number: int, *, include_html: bool
) -> dict[str, Any]:
    record: dict[str, Any] = {
        "page_number": page_number,
        "requested_url": page.requested_url,
        "final_url": page.final_url,
        "success": page.success,
        "status_code": page.status_code,
        "title": page.title,
        "markdown": page.markdown,
        "internal_links": page.internal_links,
        "external_link_count": page.external_link_count,
        "error": page.error,
    }
    if include_html:
        record["html"] = page.html
    return record


def _write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    temporary.replace(path)


def _validate_url(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("expected an absolute http:// or https:// URL")
    normalized, _ = urldefrag(value)
    return normalized


def _same_origin(left: str, right: str) -> bool:
    left_value = urlsplit(left)
    right_value = urlsplit(right)
    return (
        left_value.scheme.lower(),
        left_value.netloc.lower(),
    ) == (
        right_value.scheme.lower(),
        right_value.netloc.lower(),
    )


def _is_local_url(value: str) -> bool:
    host = (urlsplit(value).hostname or "").lower()
    return host in {"localhost", "127.0.0.1", "::1"}


def _normalize_label(value: str) -> str:
    return " ".join(value.casefold().split())


def _string_or_none(value: Any) -> str | None:
    if value is None:
        return None
    rendered = str(value).strip()
    return rendered or None


if __name__ == "__main__":
    sys.exit(main())