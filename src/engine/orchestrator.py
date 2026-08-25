from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone
from uuid import uuid4

from engine.comparables import ComparableEngine
from engine.connectors import AuditSink, DestinationConnector, NullAuditSink
from engine.models import (
    DeliveryResult,
    EngineReport,
    MarketComparable,
    SubjectProperty,
    TenantMetrics,
)
from engine.normalization import normalize_comparables, normalize_subject
from engine.reporting import report_to_dict
from engine.tenant_score import TenantScoreEngine


class CoreEngine:
    def __init__(
        self,
        *,
        comparable_engine: ComparableEngine | None = None,
        tenant_engine: TenantScoreEngine | None = None,
        audit_sink: AuditSink | None = None,
    ) -> None:
        self.comparable_engine = comparable_engine or ComparableEngine()
        self.tenant_engine = tenant_engine or TenantScoreEngine()
        self.audit_sink = audit_sink or NullAuditSink()

    def run(
        self,
        subject: SubjectProperty,
        market_records: list[MarketComparable],
        *,
        tenant_metrics: TenantMetrics | None = None,
        destinations: tuple[DestinationConnector, ...] = (),
        now: datetime | None = None,
    ) -> EngineReport:
        generated_at = now or datetime.now(timezone.utc)
        normalized_subject = normalize_subject(subject)
        normalized_market, issues = normalize_comparables(market_records)
        market = self.comparable_engine.analyze(
            normalized_subject, normalized_market, now=generated_at
        )
        tenant = self.tenant_engine.score(tenant_metrics) if tenant_metrics else None
        report = EngineReport(
            run_id=str(uuid4()),
            generated_at=generated_at,
            subject=normalized_subject,
            market=market,
            tenant=tenant,
            data_issues=tuple(issues),
            metadata={
                "market_records_received": len(market_records),
                "market_records_valid": len(normalized_market),
            },
        )

        deliveries: list[DeliveryResult] = []
        payload = report_to_dict(report)
        for destination in destinations:
            try:
                deliveries.append(destination.deliver(payload))
            except Exception as exc:  # Destination errors must not discard the report.
                deliveries.append(
                    DeliveryResult(
                        destination=destination.name,
                        status="failed",
                        reference=str(exc)[:500],
                    )
                )
        if deliveries:
            report = replace(report, deliveries=tuple(deliveries))
        self.audit_sink.record(report)
        return report

