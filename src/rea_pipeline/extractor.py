from __future__ import annotations

import json
from collections.abc import Iterator, Mapping
from html.parser import HTMLParser
from typing import Any

from rea_pipeline.errors import ExtractionError
from rea_pipeline.models import SearchBatch


class _ScriptCollector(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self._inside_script = False
        self._parts: list[str] = []
        self.scripts: list[str] = []

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        if tag.lower() == "script":
            self._inside_script = True
            self._parts = []

    def handle_data(self, data: str) -> None:
        if self._inside_script:
            self._parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "script" and self._inside_script:
            self.scripts.append("".join(self._parts))
            self._inside_script = False
            self._parts = []


def extract_argonaut_from_html(html: str) -> dict[str, Any]:
    """Decode the JSON assigned to ``window.ArgonautExchange`` in HTML."""
    candidates: list[str] = []
    try:
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(html, "html.parser")
        candidates = [script.get_text() for script in soup.find_all("script")]
    except ImportError:
        # Archived/static ingestion intentionally remains dependency-free.
        collector = _ScriptCollector()
        collector.feed(html)
        candidates = collector.scripts
    candidates = candidates or [html]

    for script in candidates:
        marker_start = 0
        while True:
            marker = script.find("window.ArgonautExchange", marker_start)
            if marker < 0:
                break
            assignment = script.find("=", marker + len("window.ArgonautExchange"))
            if assignment < 0:
                break
            value_start = assignment + 1
            while value_start < len(script) and script[value_start].isspace():
                value_start += 1
            try:
                value, _ = json.JSONDecoder().raw_decode(script[value_start:])
            except json.JSONDecodeError:
                marker_start = marker + len("window.ArgonautExchange")
                continue
            if isinstance(value, dict):
                return value

    raise ExtractionError("window.ArgonautExchange was not found as a JSON object")


def _decoded(value: Any) -> Any:
    while isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            break
    return value


def _walk(value: Any) -> Iterator[Any]:
    value = _decoded(value)
    yield value
    if isinstance(value, Mapping):
        for child in value.values():
            yield from _walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk(child)


def _find_mapping_with_key(value: Any, key: str) -> Mapping[str, Any] | None:
    for candidate in _walk(value):
        if isinstance(candidate, Mapping) and key in candidate:
            return candidate
    return None


def _find_rent_search(exchange: Mapping[str, Any]) -> Mapping[str, Any]:
    cache_parent = _find_mapping_with_key(exchange, "urqlClientCache")
    if cache_parent is None:
        raise ExtractionError("ArgonautExchange does not contain urqlClientCache")

    cache = _decoded(cache_parent["urqlClientCache"])
    if not isinstance(cache, Mapping):
        raise ExtractionError("urqlClientCache is not a JSON object")

    for entry in cache.values():
        entry = _decoded(entry)
        payload = entry.get("data") if isinstance(entry, Mapping) else entry
        parent = _find_mapping_with_key(payload, "rentSearch")
        if parent is not None and isinstance(parent["rentSearch"], Mapping):
            return parent["rentSearch"]

    raise ExtractionError("No rentSearch result was found in urqlClientCache")


def extract_rental_search(exchange: Mapping[str, Any]) -> SearchBatch:
    """Extract listing dictionaries and pagination metadata from page state."""
    search = _find_rent_search(exchange)
    results = search.get("results")
    if not isinstance(results, Mapping):
        raise ExtractionError("rentSearch.results is missing")

    exact = results.get("exact")
    items = exact.get("items") if isinstance(exact, Mapping) else None
    if not isinstance(items, list):
        raise ExtractionError("rentSearch.results.exact.items is missing")

    listings: list[dict[str, Any]] = []
    for item in items:
        listing = item.get("listing") if isinstance(item, Mapping) else None
        if isinstance(listing, dict):
            listings.append(listing)

    pagination = results.get("pagination")
    if not isinstance(pagination, Mapping):
        pagination = search.get("pagination")
    if not isinstance(pagination, Mapping):
        pagination = {}

    resolved_query = search.get("resolvedQuery")
    return SearchBatch(
        listings=listings,
        total_results=_as_int(results.get("totalResultsCount")),
        page=_as_int(pagination.get("page")),
        max_page=_as_int(pagination.get("maxPageNumberAvailable")),
        more_results=_as_bool(pagination.get("moreResultsAvailable")),
        resolved_query=dict(resolved_query) if isinstance(resolved_query, Mapping) else {},
    )


def _as_int(value: Any) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _as_bool(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None
