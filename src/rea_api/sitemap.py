from __future__ import annotations

import json
from importlib.resources import files
from typing import Any


def load_sitemap() -> list[dict[str, Any]]:
    resource = files("rea_api").joinpath("rea_sitemap.json")
    payload = json.loads(resource.read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        raise RuntimeError("REA sitemap must contain a JSON array")
    return payload


def sitemap_item(purpose: str) -> dict[str, Any]:
    for item in load_sitemap():
        if item["id"] == purpose:
            return item
    raise KeyError(purpose)
