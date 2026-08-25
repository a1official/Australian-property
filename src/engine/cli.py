from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from engine.comparables import ComparableEngine, ComparableEngineConfig
from engine.connectors import JsonlAuditSink
from engine.errors import EngineError
from engine.html_report import render_html_report
from engine.models import SubjectProperty, TenantMetrics
from engine.orchestrator import CoreEngine
from engine.reporting import report_to_dict
from engine.sqlite_market import SQLiteMarketConnector


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="core-engine",
        description="Generate an explainable property market and tenant report.",
    )
    parser.add_argument("--database", type=Path, default=Path("data/realstate.db"))
    parser.add_argument("--property-id", required=True)
    parser.add_argument("--address", required=True)
    parser.add_argument("--suburb", required=True)
    parser.add_argument("--state", required=True)
    parser.add_argument("--postcode", required=True)
    parser.add_argument("--property-type", required=True)
    parser.add_argument("--bedrooms", type=int, required=True)
    parser.add_argument("--bathrooms", type=int, required=True)
    parser.add_argument("--parking", type=int, required=True)
    parser.add_argument("--current-rent", type=int)
    parser.add_argument("--tenant-json", type=Path)
    parser.add_argument("--radius-km", type=float, default=5.0)
    parser.add_argument("--max-age-days", type=int, default=365)
    parser.add_argument("--minimum-score", type=float, default=55.0)
    parser.add_argument("--max-comparables", type=int, default=10)
    parser.add_argument("--audit-log", type=Path, default=Path("data/engine-audit.jsonl"))
    parser.add_argument(
        "--output", type=Path, default=Path("data/engine-report.html")
    )
    parser.add_argument("--json-output", type=Path)
    return parser


def _subject(args: argparse.Namespace) -> SubjectProperty:
    return SubjectProperty(
        property_id=args.property_id,
        address=args.address,
        suburb=args.suburb,
        state=args.state,
        postcode=args.postcode,
        property_type=args.property_type,
        bedrooms=args.bedrooms,
        bathrooms=args.bathrooms,
        parking_spaces=args.parking,
        current_weekly_rent=args.current_rent,
    )


def _tenant(path: Path | None) -> TenantMetrics | None:
    if path is None:
        return None
    try:
        payload: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
        return TenantMetrics(**payload)
    except (OSError, json.JSONDecodeError, TypeError) as exc:
        raise EngineError(f"could not load tenant metrics: {exc}") from exc


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    subject = _subject(args)
    try:
        records = SQLiteMarketConnector(args.database).fetch(subject)
        engine = CoreEngine(
            comparable_engine=ComparableEngine(
                ComparableEngineConfig(
                    radius_km=args.radius_km,
                    maximum_age_days=args.max_age_days,
                    minimum_score=args.minimum_score,
                    maximum_comparables=args.max_comparables,
                )
            ),
            audit_sink=JsonlAuditSink(args.audit_log),
        )
        report = engine.run(subject, records, tenant_metrics=_tenant(args.tenant_json))
        html = render_html_report(report)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(html, encoding="utf-8")
        if args.json_output:
            args.json_output.parent.mkdir(parents=True, exist_ok=True)
            args.json_output.write_text(
                json.dumps(report_to_dict(report), ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        print(
            json.dumps(
                {
                    "run_id": report.run_id,
                    "status": "completed",
                    "html_report": str(args.output.resolve()),
                    "json_report": (
                        str(args.json_output.resolve()) if args.json_output else None
                    ),
                    "suggested_weekly_rent": report.market.suggested_weekly_rent,
                    "confidence": report.market.confidence.value,
                    "comparables_selected": len(report.market.selected),
                },
                indent=2,
            )
        )
    except (EngineError, OSError, ValueError) as exc:
        print(f"engine failed: {exc}", file=sys.stderr)
        return 2
    return 0
