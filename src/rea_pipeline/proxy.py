"""Residential proxy pool for bypassing Cloudflare / anti-bot protection.

Provider-agnostic: accepts any standard http://[user:pass@]host:port URL.
No external dependencies — uses only stdlib.

Typical .env configuration
---------------------------
REA_PROXY_URLS=http://user:pass@gate.smartproxy.com:7000
REA_PROXY_ROTATE=true
REA_PROXY_MAX_RETRIES=3
REA_PROXY_TIMEOUT_SECONDS=60

Multiple proxies are comma-separated:
REA_PROXY_URLS=http://u:p@host1:7000,http://u:p@host2:7000
"""

from __future__ import annotations

import os
import random
import urllib.request
from dataclasses import dataclass, field
from urllib.parse import urlsplit


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclass(slots=True, frozen=True)
class ProxyConfig:
    """Parsed representation of a single proxy entry."""

    url: str
    """Original URL string (credentials included, for Playwright / crawl4ai)."""

    scheme: str
    host: str
    port: int
    username: str | None = None
    password: str | None = None

    @property
    def host_port(self) -> str:
        return f"{self.host}:{self.port}"

    @property
    def server_url(self) -> str:
        """URL without credentials — safe to log."""
        return f"{self.scheme}://{self.host}:{self.port}"

    def playwright_proxy(self) -> dict[str, str]:
        """Return a dict accepted by Playwright's ``proxy`` context option."""
        cfg: dict[str, str] = {"server": self.server_url}
        if self.username is not None:
            cfg["username"] = self.username
        if self.password is not None:
            cfg["password"] = self.password
        return cfg

    def crawl4ai_proxy(self) -> dict[str, str]:
        """Return a dict accepted by crawl4ai's ``BrowserConfig(proxy_config=...)``."""
        cfg: dict[str, str] = {"server": self.server_url}
        if self.username is not None:
            cfg["username"] = self.username
        if self.password is not None:
            cfg["password"] = self.password
        return cfg

    def urllib_opener(self) -> urllib.request.OpenerDirector:
        """Return an OpenerDirector that routes requests through this proxy."""
        proxy_handler = urllib.request.ProxyHandler(
            {self.scheme: self.url}
        )
        if self.username is not None:
            password_mgr = urllib.request.HTTPPasswordMgrWithDefaultRealm()
            password_mgr.add_password(None, self.server_url, self.username, self.password or "")
            auth_handler = urllib.request.ProxyBasicAuthHandler(password_mgr)
            return urllib.request.build_opener(proxy_handler, auth_handler)
        return urllib.request.build_opener(proxy_handler)


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def _parse_proxy_url(raw: str) -> ProxyConfig:
    """Parse a single proxy URL string into a ``ProxyConfig``."""
    raw = raw.strip()
    if not raw:
        raise ValueError("proxy URL must not be empty")

    # Bare host:port with no scheme — default to http://
    if "://" not in raw:
        raw = f"http://{raw}"

    parsed = urlsplit(raw)
    scheme = (parsed.scheme or "http").lower()
    if scheme not in {"http", "https", "socks5"}:
        raise ValueError(f"unsupported proxy scheme '{scheme}' in: {raw}")

    host = parsed.hostname
    if not host:
        raise ValueError(f"proxy URL has no host: {raw}")

    port = parsed.port
    if port is None:
        port = 8080

    username = parsed.username or None
    password = parsed.password or None

    return ProxyConfig(
        url=raw,
        scheme=scheme,
        host=host,
        port=port,
        username=username,
        password=password,
    )


def parse_proxy_list(raw: str) -> list[ProxyConfig]:
    """Parse a comma-separated string of proxy URLs."""
    entries = [entry.strip() for entry in raw.split(",") if entry.strip()]
    return [_parse_proxy_url(entry) for entry in entries]


# ---------------------------------------------------------------------------
# Pool
# ---------------------------------------------------------------------------


@dataclass
class ProxyPool:
    """A pool of proxy configurations with rotation / round-robin support.

    Parameters
    ----------
    proxies:
        List of ``ProxyConfig`` objects.
    rotate:
        If ``True`` (default), ``pick()`` returns a random proxy each call.
        If ``False``, proxies are returned in round-robin order.
    """

    proxies: list[ProxyConfig] = field(default_factory=list)
    rotate: bool = True
    _index: int = field(default=0, init=False, repr=False, compare=False)

    @property
    def is_empty(self) -> bool:
        return not self.proxies

    def pick(self) -> ProxyConfig | None:
        """Return the next proxy, or ``None`` if the pool is empty."""
        if not self.proxies:
            return None
        if self.rotate:
            return random.choice(self.proxies)
        proxy = self.proxies[self._index % len(self.proxies)]
        self._index += 1
        return proxy

    def pick_sequence(self, n: int) -> list[ProxyConfig | None]:
        """Return up to ``n`` distinct proxies for retry sequences.

        If the pool has fewer than ``n`` entries, some proxies will repeat.
        Always returns exactly ``n`` items.
        """
        if not self.proxies:
            return [None] * n
        if self.rotate:
            pool = list(self.proxies)
            random.shuffle(pool)
            result: list[ProxyConfig | None] = []
            for i in range(n):
                result.append(pool[i % len(pool)])
            return result
        result = []
        for i in range(n):
            result.append(self.proxies[(self._index + i) % len(self.proxies)])
        self._index = (self._index + n) % len(self.proxies)
        return result

    def __len__(self) -> int:
        return len(self.proxies)

    def __bool__(self) -> bool:
        return bool(self.proxies)


# ---------------------------------------------------------------------------
# Environment-based factory
# ---------------------------------------------------------------------------


def proxy_pool_from_env(
    urls_env: str = "REA_PROXY_URLS",
    rotate_env: str = "REA_PROXY_ROTATE",
) -> ProxyPool:
    """Build a ``ProxyPool`` from environment variables.

    Returns an empty pool (no-op) if ``REA_PROXY_URLS`` is unset or blank.

    Variables read
    --------------
    REA_PROXY_URLS   comma-separated proxy URLs
    REA_PROXY_ROTATE ``true``/``false`` (default: ``true``)
    """
    raw_urls = os.environ.get(urls_env, "").strip()
    rotate_raw = os.environ.get(rotate_env, "true").strip().lower()
    rotate = rotate_raw not in {"false", "0", "no", "off"}

    if not raw_urls:
        return ProxyPool(proxies=[], rotate=rotate)

    try:
        proxies = parse_proxy_list(raw_urls)
    except ValueError as exc:
        raise ValueError(f"invalid proxy configuration in {urls_env}: {exc}") from exc

    return ProxyPool(proxies=proxies, rotate=rotate)


def proxy_pool_from_url(url: str | None, *, rotate: bool = True) -> ProxyPool:
    """Build a single-entry pool from an explicit URL string.

    Returns an empty pool if ``url`` is ``None`` or blank.
    """
    if not url or not url.strip():
        return ProxyPool(proxies=[], rotate=rotate)
    return ProxyPool(proxies=[_parse_proxy_url(url)], rotate=rotate)


def load_proxy_settings() -> tuple[ProxyPool, int, float]:
    """Load proxy pool, max_retries, and timeout from environment.

    Returns
    -------
    pool:
        ``ProxyPool`` (may be empty if ``REA_PROXY_URLS`` is unset)
    max_retries:
        int from ``REA_PROXY_MAX_RETRIES`` (default 3)
    timeout_seconds:
        float from ``REA_PROXY_TIMEOUT_SECONDS`` (default 60)
    """
    pool = proxy_pool_from_env()

    try:
        max_retries = int(os.environ.get("REA_PROXY_MAX_RETRIES", "3"))
    except ValueError:
        max_retries = 3

    try:
        timeout_seconds = float(os.environ.get("REA_PROXY_TIMEOUT_SECONDS", "60"))
    except ValueError:
        timeout_seconds = 60.0

    return pool, max_retries, timeout_seconds
