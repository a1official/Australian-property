from __future__ import annotations

from dataclasses import dataclass

from engine.errors import ValidationError
from engine.models import TenantMetrics, TenantRating, TenantScore


@dataclass(frozen=True, slots=True)
class TenantScoreConfig:
    rule_version: str = "tenant-v1.0"


class TenantScoreEngine:
    """Deterministic, explainable scoring over authorised tenancy events."""

    def __init__(self, config: TenantScoreConfig | None = None) -> None:
        self.config = config or TenantScoreConfig()

    def score(self, metrics: TenantMetrics) -> TenantScore:
        self._validate(metrics)
        payment_ratio = (
            metrics.payments_on_time / metrics.payments_due
            if metrics.payments_due
            else 1.0
        )
        payment_points = 50 * payment_ratio

        if metrics.current_arrears == 0:
            arrears_points = 20.0
        elif metrics.current_arrears <= metrics.weekly_rent:
            arrears_points = 10.0
        elif metrics.current_arrears <= metrics.weekly_rent * 2:
            arrears_points = 5.0
        else:
            arrears_points = 0.0

        breach_points = float(max(0, 10 - metrics.breach_count * 3))
        inspection_points = _inspection_points(metrics.inspection_rating)
        stability_points = min(10.0, metrics.tenancy_months / 24 * 10)
        components = {
            "payment_history": round(payment_points, 1),
            "arrears": arrears_points,
            "documented_breaches": breach_points,
            "inspection_history": inspection_points,
            "tenancy_stability": round(stability_points, 1),
        }
        total = round(sum(components.values()))
        rating = (
            TenantRating.GOOD
            if total >= 85
            else TenantRating.AVERAGE
            if total >= 65
            else TenantRating.POOR
        )

        reasons = [f"{payment_ratio:.0%} of recorded payments were on time"]
        reasons.append(
            "No current arrears"
            if metrics.current_arrears == 0
            else f"Current arrears equal ${metrics.current_arrears}"
        )
        reasons.append(f"{metrics.breach_count} documented breaches")
        if metrics.inspection_rating:
            reasons.append(f"Inspection rating: {metrics.inspection_rating.lower()}")
        reasons.append(f"Tenancy duration: {metrics.tenancy_months} months")
        return TenantScore(
            score=total,
            rating=rating,
            reasons=tuple(reasons),
            components=components,
            rule_version=self.config.rule_version,
        )

    @staticmethod
    def _validate(metrics: TenantMetrics) -> None:
        if metrics.payments_due < 0 or metrics.payments_on_time < 0:
            raise ValidationError("payment counts cannot be negative")
        if metrics.payments_on_time > metrics.payments_due:
            raise ValidationError("payments_on_time cannot exceed payments_due")
        if metrics.current_arrears < 0 or metrics.breach_count < 0:
            raise ValidationError("arrears and breach count cannot be negative")
        if metrics.weekly_rent <= 0 or metrics.tenancy_months < 0:
            raise ValidationError("weekly rent must be positive and months non-negative")


def _inspection_points(rating: str | None) -> float:
    if rating is None:
        return 5.0
    return {
        "excellent": 10.0,
        "good": 9.0,
        "average": 6.0,
        "poor": 2.0,
    }.get(rating.strip().lower(), 5.0)

