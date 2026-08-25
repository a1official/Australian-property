from __future__ import annotations

import gzip
import sys
import zlib
from pathlib import Path
from typing import Any, Literal
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from rea_pipeline.errors import AccessBlockedError, ExtractionError, FetchError
from rea_pipeline.extractor import extract_argonaut_from_html
from rea_pipeline.proxy import ProxyConfig, ProxyPool

FetchMode = Literal["auto", "http", "browser"]


def _read_http(
    url: str,
    timeout_seconds: float,
    proxy: ProxyConfig | None = None,
) -> str:
    """Fetch ``url`` via urllib, optionally routing through ``proxy``."""
    request = Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; READataPipeline/0.1)",
            "Accept": "text/html,application/xhtml+xml",
        },
    )
    try:
        if proxy is not None:
            opener = proxy.urllib_opener()
            cm = opener.open(request, timeout=timeout_seconds)
        else:
            cm = urlopen(request, timeout=timeout_seconds)

        with cm as response:
            charset = response.headers.get_content_charset() or "utf-8"
            body = response.read()
            content_encoding = response.headers.get("Content-Encoding", "").lower()
            if content_encoding == "gzip":
                body = gzip.decompress(body)
            elif content_encoding == "deflate":
                body = zlib.decompress(body)
            elif content_encoding not in {"", "identity"}:
                raise FetchError(
                    f"unsupported HTTP content encoding: {content_encoding}"
                )
            return body.decode(charset, errors="replace")
    except HTTPError as exc:
        if exc.code in {401, 403, 429}:
            raise AccessBlockedError(
                f"source refused the HTTP request with status {exc.code}"
            ) from exc
        raise FetchError(f"HTTP request failed with status {exc.code}") from exc
    except URLError as exc:
        raise FetchError(f"HTTP request failed: {exc.reason}") from exc


def _read_html_source(
    source: str,
    timeout_seconds: float,
    proxy: ProxyConfig | None = None,
) -> str:
    parsed = urlparse(source)
    if parsed.scheme in {"http", "https"}:
        return _read_http(source, timeout_seconds, proxy=proxy)

    path = Path(source).expanduser()
    if not path.is_file():
        raise FetchError(f"HTML file does not exist: {path}")
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise FetchError(f"could not read HTML file: {exc}") from exc


def _read_with_browser(
    url: str,
    headed: bool,
    timeout_seconds: float,
    proxy: ProxyConfig | None = None,
) -> dict[str, Any]:
    try:
        from playwright.sync_api import Error as PlaywrightError
        from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise FetchError(
            'browser mode requires: pip install -e ".[browser]" and '
            "playwright install chromium"
        ) from exc

    proxy_kwargs: dict[str, Any] = {}
    if proxy is not None:
        proxy_kwargs["proxy"] = proxy.playwright_proxy()
        _log_proxy("browser", proxy)

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=not headed)
            try:
                context = browser.new_context(**proxy_kwargs)
                page = context.new_page()
                response = page.goto(
                    url,
                    wait_until="domcontentloaded",
                    timeout=timeout_seconds * 1000,
                )
                initial_status = response.status if response is not None else None
                try:
                    page.wait_for_function(
                        "() => typeof window.ArgonautExchange === 'object'",
                        timeout=min(timeout_seconds, 20) * 1000,
                    )
                except PlaywrightTimeoutError:
                    pass
                value = page.evaluate("() => window.ArgonautExchange || null")
                rendered_html = page.content() if not isinstance(value, dict) else None
            finally:
                browser.close()
    except AccessBlockedError:
        raise
    except PlaywrightError as exc:
        raise FetchError(f"browser navigation failed: {exc}") from exc

    if not isinstance(value, dict) and rendered_html:
        try:
            value = extract_argonaut_from_html(rendered_html)
        except ExtractionError:
            pass

    if not isinstance(value, dict):
        if initial_status in {401, 403, 429}:
            raise AccessBlockedError(
                f"source returned status {initial_status} and the browser session "
                "did not reach the expected page state"
            )
        raise ExtractionError(
            "the loaded page did not expose window.ArgonautExchange; it may be "
            "blocked, challenged, or no longer use that page-state format"
        )
    return value


def load_argonaut(
    source: str,
    mode: FetchMode = "auto",
    *,
    headed: bool = False,
    timeout_seconds: float = 45,
    proxy_pool: ProxyPool | None = None,
    max_proxy_retries: int = 3,
) -> tuple[dict[str, Any], str]:
    """Load embedded page state from an HTTP URL, saved HTML, or browser.

    When ``proxy_pool`` is supplied and a fetch is blocked (429 / 403 /
    AccessBlockedError), the call is retried up to ``max_proxy_retries`` times
    with a fresh proxy from the pool on each attempt.
    """
    if mode not in {"auto", "http", "browser"}:
        raise ValueError(f"unsupported fetch mode: {mode}")

    # Build the retry sequence: first attempt may use no proxy if pool is empty,
    # then up to max_proxy_retries attempts each with a proxy.
    attempts: list[ProxyConfig | None]
    if proxy_pool and not proxy_pool.is_empty:
        # First try: no proxy (fast path). If blocked, retry with proxies.
        attempts = [None] + proxy_pool.pick_sequence(max_proxy_retries)
    else:
        attempts = [None]

    last_error: Exception | None = None

    for attempt_index, proxy in enumerate(attempts):
        try:
            return _load_argonaut_once(
                source,
                mode,
                headed=headed,
                timeout_seconds=timeout_seconds,
                proxy=proxy,
            )
        except AccessBlockedError as exc:
            last_error = exc
            if attempt_index < len(attempts) - 1:
                next_proxy = attempts[attempt_index + 1]
                proxy_label = next_proxy.server_url if next_proxy else "no proxy"
                print(
                    f"[proxy] blocked (attempt {attempt_index + 1}), "
                    f"retrying via {proxy_label}",
                    file=__import__("sys").stderr,
                )
            continue
        except (FetchError, ExtractionError):
            raise

    # All proxy attempts exhausted
    assert last_error is not None
    raise last_error


def _load_argonaut_once(
    source: str,
    mode: FetchMode,
    *,
    headed: bool,
    timeout_seconds: float,
    proxy: ProxyConfig | None,
) -> tuple[dict[str, Any], str]:
    """Single fetch attempt — no retry logic."""
    if mode == "browser":
        return _read_with_browser(source, headed, timeout_seconds, proxy=proxy), "browser"

    direct_error: Exception | None = None
    try:
        html = _read_html_source(source, timeout_seconds, proxy=proxy)
        direct_mode = "http" if urlparse(source).scheme in {"http", "https"} else "file"
        return extract_argonaut_from_html(html), direct_mode
    except (FetchError, ExtractionError) as exc:
        direct_error = exc
        if mode == "http" or urlparse(source).scheme not in {"http", "https"}:
            raise

    try:
        return _read_with_browser(source, headed, timeout_seconds, proxy=proxy), "browser"
    except (FetchError, ExtractionError) as browser_error:
        raise FetchError(
            f"direct collection failed ({direct_error}); browser collection also "
            f"failed ({browser_error})"
        ) from browser_error


def _log_proxy(label: str, proxy: ProxyConfig) -> None:
    print(
        f"[proxy] {label} → {proxy.server_url}",
        file=sys.stderr,
    )
