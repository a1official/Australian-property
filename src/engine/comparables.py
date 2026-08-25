from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from statistics import mean, median

from engine.errors import InsufficientComparablesError
from engine.models import (
    ComparableMatch,
    Confidence,
    Coordinates,
    MarketCalculation,
    MarketComparable,
    MarketRecommendation,
    SubjectProperty,
)


@dataclass(frozen=True, slots=True)
class ComparableEngineConfig:
    radius_km: float = 5.0
    maximum_age_days: int = 365
    minimum_score: float = 55.0
    maximum_comparables: int = 10
    allow_property_type_mismatch: bool = False
    rule_version: str = "market-v1.0"


class ComparableEngine:
    def __init__(self, config: ComparableEngineConfig | None = None) -> None:
        self.config = config or ComparableEngineConfig()

    def analyze(
        self,
        subject: SubjectProperty,
        records: list[MarketComparable],
        *,
        now: datetime | None = None,
    ) -> MarketRecommendation:
        evaluation_time = now or datetime.now(timezone.utc)
        matches: list[ComparableMatch] = []
        hard_rejections: Counter[str] = Counter()
        below_minimum_score = 0

        for record in records:
            match, rejection_reason = self._evaluate(subject, record, evaluation_time)
            if match is None:
                hard_rejections[rejection_reason or "other rule"] += 1
                continue
            if match.score < self.config.minimum_score:
                below_minimum_score += 1
                continue
            matches.append(match)

        matches.sort(key=lambda item: (-item.score, item.comparable.listing_id))
        plausible_matches, outlier_statistics = _rent_outlier_result(matches)
        outliers_removed = len(matches) - len(plausible_matches)
        selected = plausible_matches[: self.config.maximum_comparables]
        top_n_excluded = max(0, len(plausible_matches) - len(selected))
        if not selected:
            raise InsufficientComparablesError(
                "no market records passed the comparable-selection rules"
            )

        rents = sorted(item.comparable.weekly_rent for item in selected)
        average_score = round(mean(item.score for item in selected), 1)
        selected_median = float(median(rents))
        selected_first_quartile = _percentile(rents, 0.25)
        selected_third_quartile = _percentile(rents, 0.75)
        suggested = _round_to_five(selected_median)
        low = _round_to_five(selected_first_quartile)
        high = _round_to_five(selected_third_quartile)
        confidence = _confidence(len(selected), average_score)
        rejected_count = (
            sum(hard_rejections.values())
            + below_minimum_score
            + outliers_removed
            + top_n_excluded
        )
        calculation = MarketCalculation(
            records_evaluated=len(records),
            hard_filter_rejections=dict(sorted(hard_rejections.items())),
            below_minimum_score=below_minimum_score,
            passed_similarity=len(matches),
            rent_first_quartile=outlier_statistics["first_quartile"],
            rent_third_quartile=outlier_statistics["third_quartile"],
            rent_iqr=outlier_statistics["iqr"],
            rent_lower_bound=outlier_statistics["lower_bound"],
            rent_upper_bound=outlier_statistics["upper_bound"],
            rent_outliers_removed=outliers_removed,
            top_n_excluded=top_n_excluded,
            selected_rents=tuple(rents),
            selected_median=selected_median,
            selected_first_quartile=selected_first_quartile,
            selected_third_quartile=selected_third_quartile,
            minimum_score=self.config.minimum_score,
            maximum_comparables=self.config.maximum_comparables,
            high_confidence_minimum_count=5,
            high_confidence_minimum_score=75.0,
        )

        return MarketRecommendation(
            suggested_weekly_rent=suggested,
            low_weekly_rent=min(low, suggested),
            high_weekly_rent=max(high, suggested),
            confidence=confidence,
            average_match_score=average_score,
            selected=tuple(selected),
            rejected_count=rejected_count,
            rule_version=self.config.rule_version,
            calculation=calculation,
        )

    def _score(
        self,
        subject: SubjectProperty,
        record: MarketComparable,
        now: datetime,
    ) -> ComparableMatch | None:
        match, _ = self._evaluate(subject, record, now)
        return match

    def _evaluate(
        self,
        subject: SubjectProperty,
        record: MarketComparable,
        now: datetime,
    ) -> tuple[ComparableMatch | None, str | None]:
        if record.listing_id == subject.property_id:
            return None, "subject property"
        if record.address and record.address.casefold() == subject.address.casefold():
            return None, "subject property"
        if record.state != subject.state:
            return None, "different state"
        if (
            record.property_type != subject.property_type
            and not self.config.allow_property_type_mismatch
        ):
            return None, "different property type"

        bedroom_delta = abs(record.bedrooms - subject.bedrooms)
        bathroom_delta = abs(record.bathrooms - subject.bathrooms)
        parking_delta = abs(record.parking_spaces - subject.parking_spaces)
        if bedroom_delta > 1:
            return None, "bedroom difference greater than one"
        if bathroom_delta > 1:
            return None, "bathroom difference greater than one"
        if parking_delta > 2:
            return None, "parking difference greater than two"

        distance = _distance(subject.coordinates, record.coordinates)
        same_suburb = record.suburb.casefold() == subject.suburb.casefold()
        same_postcode = record.postcode == subject.postcode
        if distance is not None and distance > self.config.radius_km:
            return None, "outside radius"
        if distance is None and not (same_suburb or same_postcode):
            return None, "different locality"

        components: dict[str, float] = {}
        reasons: list[str] = []

        if record.property_type == subject.property_type:
            components["property_type"] = 20.0
            reasons.append("same property type")
        else:
            components["property_type"] = 8.0

        components["bedrooms"] = 20.0 if bedroom_delta == 0 else 10.0
        reasons.append("same bedrooms" if bedroom_delta == 0 else "bedrooms differ by one")
        components["bathrooms"] = 15.0 if bathroom_delta == 0 else 7.5
        reasons.append(
            "same bathrooms" if bathroom_delta == 0 else "bathrooms differ by one"
        )
        if parking_delta == 0:
            components["parking"] = 10.0
            reasons.append("same parking")
        elif parking_delta == 1:
            components["parking"] = 5.0
        else:
            components["parking"] = 0.0

        if distance is not None:
            location_score = 25 * max(0.0, 1 - distance / self.config.radius_km)
            components["location"] = location_score
            reasons.append(f"{distance:.1f} km away")
        elif same_postcode:
            components["location"] = 25.0
            reasons.append("same postcode")
        else:
            components["location"] = 22.0
            reasons.append("same suburb")

        collected_at = record.collected_at
        if collected_at.tzinfo is None:
            collected_at = collected_at.replace(tzinfo=timezone.utc)
        age_days = max(0, (now - collected_at).days)
        if age_days > self.config.maximum_age_days:
            return None, "stale record"
        recency_score = 10 * (1 - age_days / self.config.maximum_age_days)
        components["recency"] = max(0, recency_score)
        reasons.append(f"observed {age_days} days ago")
        score = sum(components.values())

        return (
            ComparableMatch(
                comparable=record,
                score=round(score, 1),
                distance_km=round(distance, 2) if distance is not None else None,
                reasons=tuple(reasons),
                components={key: round(value, 1) for key, value in components.items()},
            ),
            None,
        )


def _distance(
    first: Coordinates | None, second: Coordinates | None
) -> float | None:
    if first is None or second is None:
        return None
    radius = 6371.0088
    lat1, lat2 = math.radians(first.latitude), math.radians(second.latitude)
    delta_lat = math.radians(second.latitude - first.latitude)
    delta_lon = math.radians(second.longitude - first.longitude)
    haversine = (
        math.sin(delta_lat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2) ** 2
    )
    return radius * 2 * math.atan2(math.sqrt(haversine), math.sqrt(1 - haversine))


def _percentile(values: list[int], percentile: float) -> float:
    if len(values) == 1:
        return float(values[0])
    position = (len(values) - 1) * percentile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return float(values[lower])
    fraction = position - lower
    return values[lower] + (values[upper] - values[lower]) * fraction


def _round_to_five(value: float) -> int:
    return int(5 * round(value / 5))


def _remove_rent_outliers(matches: list[ComparableMatch]) -> list[ComparableMatch]:
    filtered, _ = _rent_outlier_result(matches)
    return filtered


def _rent_outlier_result(
    matches: list[ComparableMatch],
) -> tuple[list[ComparableMatch], dict[str, float | None]]:
    if len(matches) < 4:
        return matches, {
            "first_quartile": None,
            "third_quartile": None,
            "iqr": None,
            "lower_bound": None,
            "upper_bound": None,
        }
    rents = sorted(item.comparable.weekly_rent for item in matches)
    first_quartile = _percentile(rents, 0.25)
    third_quartile = _percentile(rents, 0.75)
    spread = third_quartile - first_quartile
    lower_bound = max(0, first_quartile - 1.5 * spread)
    upper_bound = third_quartile + 1.5 * spread
    return (
        [
            item
            for item in matches
            if lower_bound <= item.comparable.weekly_rent <= upper_bound
        ],
        {
            "first_quartile": first_quartile,
            "third_quartile": third_quartile,
            "iqr": spread,
            "lower_bound": lower_bound,
            "upper_bound": upper_bound,
        },
    )


def _confidence(count: int, average_score: float) -> Confidence:
    if count >= 5 and average_score >= 75:
        return Confidence.HIGH
    if count >= 3 and average_score >= 60:
        return Confidence.MEDIUM
    return Confidence.LOW
