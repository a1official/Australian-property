from datetime import datetime, timedelta, timezone
from dataclasses import replace

import pytest

from engine.comparables import ComparableEngine
from engine.connectors import JsonlAuditSink
from engine.errors import ValidationError
from engine.html_report import render_html_report
from engine.models import MarketComparable, SubjectProperty, TenantMetrics
from engine.orchestrator import CoreEngine
from engine.reporting import report_to_dict
from engine.tenant_score import TenantScoreEngine

NOW = datetime(2026, 8, 7, tzinfo=timezone.utc)


def subject() -> SubjectProperty:
    return SubjectProperty(
        property_id="PT-1",
        address="10 Example Street, Sydney NSW 2000",
        suburb="Sydney",
        state="NSW",
        postcode="2000",
        property_type="unit",
        bedrooms=2,
        bathrooms=2,
        parking_spaces=1,
        current_weekly_rent=900,
    )


def comparable(listing_id: str, rent: int, **changes) -> MarketComparable:
    values = {
        "source": "fixture",
        "listing_id": listing_id,
        "address": f"{listing_id} Market Street, Sydney NSW 2000",
        "suburb": "Sydney",
        "state": "NSW",
        "postcode": "2000",
        "property_type": "apartment",
        "bedrooms": 2,
        "bathrooms": 2,
        "parking_spaces": 1,
        "weekly_rent": rent,
        "collected_at": NOW - timedelta(days=10),
    }
    values.update(changes)
    return MarketComparable(**values)


def test_comparables_engine_is_explainable_and_robust_to_outlier() -> None:
    records = [
        comparable("1", 900),
        comparable("2", 920),
        comparable("3", 940),
        comparable("4", 960),
        comparable("5", 980),
        comparable("outlier", 3500),
        comparable("wrong-state", 500, state="VIC"),
    ]

    report = CoreEngine().run(subject(), records, now=NOW)

    assert report.market.suggested_weekly_rent == 940
    assert report.market.low_weekly_rent == 920
    assert report.market.high_weekly_rent == 960
    assert report.market.confidence.value == "high"
    assert len(report.market.selected) == 5
    assert report.market.rejected_count == 2
    assert "same property type" in report.market.selected[0].reasons
    assert report.market.selected[0].components["bedrooms"] == 20
    assert report.market.calculation.hard_filter_rejections == {"different state": 1}
    assert report.market.calculation.rent_outliers_removed == 1
    assert report.market.calculation.selected_rents == (900, 920, 940, 960, 980)


def test_tenant_score_is_rules_based() -> None:
    metrics = TenantMetrics(
        tenancy_id="TEN-1",
        payments_due=100,
        payments_on_time=98,
        current_arrears=0,
        weekly_rent=900,
        breach_count=0,
        tenancy_months=30,
        inspection_rating="good",
    )

    result = TenantScoreEngine().score(metrics)

    assert result.score == 98
    assert result.rating.value == "good"
    assert result.components["payment_history"] == 49
    assert "No current arrears" in result.reasons


def test_tenant_score_rejects_inconsistent_payments() -> None:
    metrics = TenantMetrics(
        tenancy_id="TEN-1",
        payments_due=10,
        payments_on_time=11,
        current_arrears=0,
        weekly_rent=900,
        breach_count=0,
        tenancy_months=1,
    )

    with pytest.raises(ValidationError):
        TenantScoreEngine().score(metrics)


def test_orchestrator_records_minimized_audit_event(tmp_path) -> None:
    audit_path = tmp_path / "audit.jsonl"
    engine = CoreEngine(audit_sink=JsonlAuditSink(audit_path))

    report = engine.run(
        subject(),
        [comparable(str(index), 900 + index * 10) for index in range(1, 6)],
        now=NOW,
    )
    payload = report_to_dict(report)

    assert payload["summary"]["market"].startswith("Based on 5 selected")
    assert audit_path.read_text(encoding="utf-8").count("\n") == 1
    audit_text = audit_path.read_text(encoding="utf-8")
    assert "TEN-" not in audit_text


def test_html_report_is_self_contained_and_escapes_source_text() -> None:
    unsafe_subject = replace(subject(), address="<script>alert('x')</script>")
    report = CoreEngine().run(
        unsafe_subject,
        [comparable(str(index), 900 + index * 10) for index in range(1, 6)],
        now=NOW,
    )

    html = render_html_report(report)

    assert "<!doctype html>" in html
    assert "Market &amp; Tenancy Brief" in html
    assert "Selected comparables" in html
    assert "Input-specific calculation" in html
    assert "Calculation trail" in html
    assert "2 bed · 2 bath · 1 car" in html
    assert "&lt;script&gt;alert" in html
    assert "<script>alert" not in html
    assert "<link" not in html
    assert "<script src" not in html
    assert "@media print" in html
