from __future__ import annotations

from dataclasses import asdict
from datetime import date, datetime
from enum import Enum
from typing import Any

from engine.models import EngineReport, SubjectProperty, TenantScore


def report_to_dict(report: EngineReport) -> dict[str, Any]:
    payload = _serialize(asdict(report))
    payload["summary"] = _summary(report)
    return payload


def _serialize(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _serialize(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_serialize(item) for item in value]
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Enum):
        return value.value
    return value


def _summary(report: EngineReport) -> dict[str, str]:
    market = report.market
    market_text = (
        f"Based on {len(market.selected)} selected comparables, the suggested "
        f"market rent is ${market.suggested_weekly_rent} per week, with an "
        f"observed range of ${market.low_weekly_rent}–${market.high_weekly_rent}. "
        f"Confidence is {market.confidence.value}."
    )
    return {
        "market": market_text,
        "rent_change": _rent_change(report.subject, market.suggested_weekly_rent),
        "tenant": _tenant_summary(report.tenant),
    }


def _rent_change(subject: SubjectProperty, suggested_rent: int) -> str:
    current = subject.current_weekly_rent
    if current is None:
        return "Current rent was not supplied, so no rent-change calculation was made."
    difference = suggested_rent - current
    percentage = difference / current * 100
    direction = "increase" if difference >= 0 else "decrease"
    return (
        f"The suggestion represents a ${abs(difference)} weekly {direction} "
        f"({abs(percentage):.1f}%) from the current rent of ${current}."
    )


def _tenant_summary(score: TenantScore | None) -> str:
    if score is None:
        return "Tenant score was not calculated because no authorised metrics were supplied."
    return (
        f"The rules-based tenant rating is {score.rating.value} "
        f"({score.score}/100)."
    )

