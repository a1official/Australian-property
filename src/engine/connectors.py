from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Protocol

from engine.models import DeliveryResult, EngineReport, MarketComparable, SubjectProperty


class MarketConnector(Protocol):
    def fetch(self, subject: SubjectProperty) -> list[MarketComparable]: ...


class DestinationConnector(Protocol):
    @property
    def name(self) -> str: ...

    def deliver(self, report: dict[str, Any]) -> DeliveryResult: ...


class AuditSink(Protocol):
    def record(self, report: EngineReport) -> None: ...


class NullAuditSink:
    def record(self, report: EngineReport) -> None:
        return None


class JsonlAuditSink:
    """Append a privacy-minimized run record to a local JSONL audit log."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)

    def record(self, report: EngineReport) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        event = {
            "run_id": report.run_id,
            "generated_at": report.generated_at.isoformat(),
            "property_id": report.subject.property_id,
            "status": "completed",
            "market_rule_version": report.market.rule_version,
            "tenant_rule_version": report.tenant.rule_version if report.tenant else None,
            "comparables_selected": [
                item.comparable.listing_id for item in report.market.selected
            ],
            "suggested_weekly_rent": report.market.suggested_weekly_rent,
            "confidence": report.market.confidence.value,
            "tenant_rating": report.tenant.rating.value if report.tenant else None,
            "data_issue_count": len(report.data_issues),
            "deliveries": [
                {"destination": item.destination, "status": item.status}
                for item in report.deliveries
            ],
        }
        with self.path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")))
            stream.write("\n")

