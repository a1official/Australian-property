from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from urllib.parse import unquote, urlparse

from rea_pipeline.errors import AccessBlockedError, FetchError


PROPERTY_TREE_AGENT_URL = "https://agent.propertytree.com/"
_ALLOWED_SCRIPT_HOSTS = ("propertytree.com", "mrisoftware.com")
_ABSOLUTE_URL = re.compile(r"https?://[^\s\"'`<>\\]+", re.IGNORECASE)
_ROUTE_STRING = re.compile(
    r"[\"'`]((?:/|\./)(?:api|graphql|connect|account|authentication|oauth|oidc|v[0-9]+)"
    r"[^\s\"'`<>\\]*)[\"'`]",
    re.IGNORECASE,
)
_INTERESTING_PATH = re.compile(
    r"(?:^|/)(?:api|graphql|connect|account|authentication|oauth|oidc|token|v[0-9]+)(?:/|$)",
    re.IGNORECASE,
)
_STATIC_SUFFIXES = (
    ".css",
    ".gif",
    ".ico",
    ".jpeg",
    ".jpg",
    ".js",
    ".map",
    ".png",
    ".svg",
    ".webp",
    ".woff",
    ".woff2",
)


@dataclass(frozen=True, slots=True)
class BundleRecord:
    filename: str
    source_url: str
    sha256: str
    bytes: int


@dataclass(frozen=True, slots=True)
class EndpointCandidate:
    value: str
    bundle: str
    kind: str


def _approved_host(hostname: str | None) -> bool:
    host = (hostname or "").lower()
    return any(host == suffix or host.endswith(f".{suffix}") for suffix in _ALLOWED_SCRIPT_HOSTS)


def _safe_filename(url: str, body: bytes) -> str:
    path_name = Path(unquote(urlparse(url).path)).name or "bundle.js"
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", path_name).strip("-") or "bundle.js"
    if not stem.lower().endswith(".js"):
        stem += ".js"
    digest = hashlib.sha256(body).hexdigest()[:12]
    return f"{Path(stem).stem}-{digest}.js"


def find_endpoint_candidates(text: str, bundle: str) -> list[EndpointCandidate]:
    candidates: dict[tuple[str, str], EndpointCandidate] = {}
    for match in _ABSOLUTE_URL.finditer(text):
        value = match.group(0).rstrip("),.;]")
        parsed = urlparse(value)
        path = parsed.path.casefold()
        if path.endswith(_STATIC_SUFFIXES):
            continue
        if _INTERESTING_PATH.search(path) or any(
            keyword in parsed.netloc.casefold()
            for keyword in ("api", "identity", "auth", "gateway")
        ):
            item = EndpointCandidate(value=value, bundle=bundle, kind="absolute-url")
            candidates[(item.kind, item.value)] = item

    for match in _ROUTE_STRING.finditer(text):
        value = match.group(1)
        if urlparse(value).path.casefold().endswith(_STATIC_SUFFIXES):
            continue
        item = EndpointCandidate(value=value, bundle=bundle, kind="relative-route")
        candidates[(item.kind, item.value)] = item
    return sorted(candidates.values(), key=lambda item: (item.kind, item.value))


def analyse_saved_bundles(records: list[BundleRecord], output_dir: Path) -> list[EndpointCandidate]:
    candidates: dict[tuple[str, str, str], EndpointCandidate] = {}
    for record in records:
        text = (output_dir / record.filename).read_text(encoding="utf-8", errors="replace")
        for item in find_endpoint_candidates(text, record.filename):
            candidates[(item.bundle, item.kind, item.value)] = item
    return sorted(candidates.values(), key=lambda item: (item.bundle, item.kind, item.value))


def collect_property_tree_assets(
    output_dir: Path,
    *,
    headed: bool = False,
    profile_dir: Path | None = None,
    login_wait_seconds: int = 0,
    timeout_seconds: float = 45,
) -> dict[str, object]:
    """Capture Property Tree scripts delivered to a normal Playwright page session.

    No credentials, cookies, authorization headers, tokens, or response API payloads
    are persisted. A persistent profile may be used for a user-completed login, but
    must remain outside version control.
    """
    if login_wait_seconds < 0 or login_wait_seconds > 600:
        raise ValueError("login_wait_seconds must be between 0 and 600")
    if login_wait_seconds and not headed:
        raise ValueError("a login wait requires --headed so the user can sign in")

    try:
        from playwright.sync_api import Error as PlaywrightError
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise FetchError(
            'asset collection requires: pip install -e ".[browser]" and '
            "playwright install chromium"
        ) from exc

    output_dir.mkdir(parents=True, exist_ok=True)
    captured: dict[str, bytes] = {}
    page_details: dict[str, object] = {}

    def capture(response) -> None:
        parsed = urlparse(response.url)
        if response.request.resource_type != "script" or not _approved_host(parsed.hostname):
            return
        if response.status != 200 or response.url in captured:
            return
        try:
            captured[response.url] = response.body()
        except PlaywrightError:
            return

    try:
        with sync_playwright() as playwright:
            if profile_dir:
                profile_dir.mkdir(parents=True, exist_ok=True)
                context = playwright.chromium.launch_persistent_context(
                    str(profile_dir.resolve()), headless=not headed
                )
                browser = None
            else:
                browser = playwright.chromium.launch(headless=not headed)
                context = browser.new_context()
            try:
                page = context.pages[0] if context.pages else context.new_page()
                page.on("response", capture)
                response = page.goto(
                    PROPERTY_TREE_AGENT_URL,
                    wait_until="domcontentloaded",
                    timeout=timeout_seconds * 1000,
                )
                status = response.status if response else None
                if status in {401, 403, 429}:
                    raise AccessBlockedError(
                        f"Property Tree refused the browser page with status {status}"
                    )

                if login_wait_seconds:
                    deadline = time.monotonic() + login_wait_seconds
                    while time.monotonic() < deadline:
                        if urlparse(page.url).hostname == "agent.propertytree.com":
                            break
                        page.wait_for_timeout(500)
                page.wait_for_timeout(2000)
                page_details = {
                    "final_url_origin": (
                        f"{urlparse(page.url).scheme}://{urlparse(page.url).netloc}/"
                    ),
                    "title": page.title(),
                    "authenticated_application_reached": (
                        urlparse(page.url).hostname == "agent.propertytree.com"
                    ),
                }
            finally:
                context.close()
                if browser is not None:
                    browser.close()
    except AccessBlockedError:
        raise
    except PlaywrightError as exc:
        raise FetchError(f"Property Tree browser collection failed: {exc}") from exc

    records: list[BundleRecord] = []
    for source_url, body in sorted(captured.items()):
        filename = _safe_filename(source_url, body)
        (output_dir / filename).write_bytes(body)
        records.append(
            BundleRecord(
                filename=filename,
                source_url=source_url,
                sha256=hashlib.sha256(body).hexdigest(),
                bytes=len(body),
            )
        )

    endpoints = analyse_saved_bundles(records, output_dir)
    manifest = {
        "entry_url": PROPERTY_TREE_AGENT_URL,
        "page": page_details,
        "security": {
            "tokens_or_credentials_saved": False,
            "api_responses_saved": False,
            "scope": "browser-delivered JavaScript from approved Property Tree/MRI hosts",
        },
        "bundles": [asdict(item) for item in records],
        "endpoint_candidates": [asdict(item) for item in endpoints],
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return manifest


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="property-tree-assets",
        description="Capture browser-delivered Property Tree JS and inventory endpoint-shaped strings.",
    )
    parser.add_argument(
        "--output-dir", type=Path, default=Path("artifacts/property-tree-bundles")
    )
    parser.add_argument("--headed", action="store_true")
    parser.add_argument(
        "--profile-dir",
        type=Path,
        help="ignored local Playwright profile used for a user-completed authorised login",
    )
    parser.add_argument(
        "--login-wait-seconds",
        type=int,
        default=0,
        help="headed-only time window for the user to complete normal login/MFA",
    )
    parser.add_argument("--timeout", type=float, default=45)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        manifest = collect_property_tree_assets(
            args.output_dir,
            headed=args.headed,
            profile_dir=args.profile_dir,
            login_wait_seconds=args.login_wait_seconds,
            timeout_seconds=args.timeout,
        )
    except (FetchError, OSError, ValueError) as exc:
        print(f"Property Tree asset collection failed: {exc}", file=sys.stderr)
        return 2

    print(
        json.dumps(
            {
                "status": "completed",
                "authenticated_application_reached": manifest["page"][
                    "authenticated_application_reached"
                ],
                "bundle_count": len(manifest["bundles"]),
                "endpoint_candidate_count": len(manifest["endpoint_candidates"]),
                "manifest": str((args.output_dir / "manifest.json").resolve()),
            },
            indent=2,
        )
    )
    return 0
