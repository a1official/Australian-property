/**
 * Verifies the shared Cotality similarity scoring and candidate mapping.
 *
 * These weights drive which properties appear in a client-facing rent review,
 * so each component is asserted independently rather than only via a total.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  MINIMUM_REPORT_CANDIDATES,
  RENTAL_COMPARABLES_RULE_ID,
  candidatesFromComparables,
  comparablesRequestBody,
  coordinate,
  enrichCandidateImages,
  haversineKm,
  marketRentSummary,
  record,
  scoreCandidate,
  scoreDifference,
  selectReportCandidates,
  weeklyRent,
  type JsonRecord,
} from "../lib/cotality-comparables";
import { selectQualityComparableRents } from "../lib/report-html";

const REFERENCE = {
  propertyId: 1000,
  propertyType: "UNIT",
  beds: 2,
  baths: 1,
  carSpaces: 1,
  floorArea: 100,
  landArea: null,
};

function candidate(overrides: JsonRecord = {}): JsonRecord {
  return { propertyType: "UNIT", beds: 2, baths: 1, carSpaces: 1, floorArea: 100, distanceKm: 0.2, ...overrides };
}

// ---------------------------------------------------------------------------
// Component weights
// ---------------------------------------------------------------------------

test("a fully identical candidate scores the maximum 100", () => {
  const score = scoreCandidate(REFERENCE, candidate());
  assert.equal(score.total, 100);
  assert.deepEqual(score.breakdown, { type: 35, bedrooms: 20, bathrooms: 15, cars: 10, area: 10, location: 10 });
});

test("property type awards 35 only on an exact match", () => {
  assert.equal(scoreCandidate(REFERENCE, candidate()).breakdown.type, 35);
  assert.equal(scoreCandidate(REFERENCE, candidate({ propertyType: "HOUSE" })).breakdown.type, 0);
});

test("property type comparison ignores case", () => {
  assert.equal(scoreCandidate(REFERENCE, candidate({ propertyType: "unit" })).breakdown.type, 35);
});

test("bedrooms score 20 exact and 10 for a difference of one", () => {
  assert.equal(scoreCandidate(REFERENCE, candidate({ beds: 2 })).breakdown.bedrooms, 20);
  assert.equal(scoreCandidate(REFERENCE, candidate({ beds: 3 })).breakdown.bedrooms, 10);
  assert.equal(scoreCandidate(REFERENCE, candidate({ beds: 1 })).breakdown.bedrooms, 10);
  assert.equal(scoreCandidate(REFERENCE, candidate({ beds: 4 })).breakdown.bedrooms, 0);
});

test("bathrooms score 15 exact and 7 for a difference of one", () => {
  assert.equal(scoreCandidate(REFERENCE, candidate({ baths: 1 })).breakdown.bathrooms, 15);
  assert.equal(scoreCandidate(REFERENCE, candidate({ baths: 2 })).breakdown.bathrooms, 7);
  assert.equal(scoreCandidate(REFERENCE, candidate({ baths: 3 })).breakdown.bathrooms, 0);
});

test("car spaces score 10 exact and 5 for a difference of one", () => {
  assert.equal(scoreCandidate(REFERENCE, candidate({ carSpaces: 1 })).breakdown.cars, 10);
  assert.equal(scoreCandidate(REFERENCE, candidate({ carSpaces: 2 })).breakdown.cars, 5);
  assert.equal(scoreCandidate(REFERENCE, candidate({ carSpaces: 4 })).breakdown.cars, 0);
});

test("scoreDifference never rewards a missing value", () => {
  assert.equal(scoreDifference(null, 2, 20, 10), 0);
  assert.equal(scoreDifference(2, null, 20, 10), 0);
  assert.equal(scoreDifference(null, null, 20, 10), 0);
});

// ---------------------------------------------------------------------------
// Area threshold
// ---------------------------------------------------------------------------

test("area scores 10 within the 25% threshold and 0 beyond it", () => {
  assert.equal(scoreCandidate(REFERENCE, candidate({ floorArea: 100 })).breakdown.area, 10);
  assert.equal(scoreCandidate(REFERENCE, candidate({ floorArea: 125 })).breakdown.area, 10, "exactly +25% qualifies");
  assert.equal(scoreCandidate(REFERENCE, candidate({ floorArea: 75 })).breakdown.area, 10, "exactly -25% qualifies");
  assert.equal(scoreCandidate(REFERENCE, candidate({ floorArea: 126 })).breakdown.area, 0);
  assert.equal(scoreCandidate(REFERENCE, candidate({ floorArea: 74 })).breakdown.area, 0);
});

test("land area is compared when either side lacks a floor area", () => {
  const landReference = { ...REFERENCE, floorArea: null, landArea: 400 };
  assert.equal(scoreCandidate(landReference, candidate({ floorArea: null, landArea: 420 })).breakdown.area, 10);
  assert.equal(scoreCandidate(landReference, candidate({ floorArea: null, landArea: 900 })).breakdown.area, 0);
});

test("a missing area on either side scores zero", () => {
  assert.equal(scoreCandidate(REFERENCE, candidate({ floorArea: null, landArea: null })).breakdown.area, 0);
  assert.equal(
    scoreCandidate({ ...REFERENCE, floorArea: null, landArea: null }, candidate()).breakdown.area,
    0,
  );
});

test("a zero reference area cannot divide by zero or award points", () => {
  assert.equal(scoreCandidate({ ...REFERENCE, floorArea: 0, landArea: 0 }, candidate({ floorArea: 0 })).breakdown.area, 0);
});

// ---------------------------------------------------------------------------
// Distance
// ---------------------------------------------------------------------------

test("distance thresholds score 10/8/6/4/0", () => {
  const at = (distanceKm: number | null) => scoreCandidate(REFERENCE, candidate({ distanceKm })).breakdown.location;
  assert.equal(at(0.5), 10);
  assert.equal(at(1), 8);
  assert.equal(at(3), 6);
  assert.equal(at(5), 4);
  assert.equal(at(5.1), 0);
  assert.equal(at(null), 0, "unknown distance must not score");
});

test("haversine distance is symmetric and plausible", () => {
  const sydney = { latitude: -33.8688, longitude: 151.2093 };
  const parramatta = { latitude: -33.815, longitude: 151.0 };
  const distance = haversineKm(sydney, parramatta);
  assert.ok(distance > 18 && distance < 25, `expected roughly 20km, got ${distance}`);
  assert.equal(distance, haversineKm(parramatta, sydney));
  assert.equal(haversineKm(sydney, sydney), 0);
});

test("a coordinate requires both latitude and longitude", () => {
  assert.deepEqual(coordinate({ latitude: -33.8, longitude: 151.2 }), { latitude: -33.8, longitude: 151.2 });
  assert.equal(coordinate({ latitude: -33.8 }), null);
  assert.equal(coordinate(null), null);
});

test("an empty candidate scores zero rather than accumulating points", () => {
  const score = scoreCandidate(REFERENCE, {});
  assert.equal(score.total, 0);
  assert.deepEqual(score.breakdown, { type: 0, bedrooms: 0, bathrooms: 0, cars: 0, area: 0, location: 0 });
});

// ---------------------------------------------------------------------------
// Weekly rent
// ---------------------------------------------------------------------------

test("only weekly rent periods are accepted", () => {
  assert.equal(weeklyRent({ price: 650, period: "W" }), 650);
  assert.equal(weeklyRent({ price: 650, period: "WEEKLY" }), 650);
  assert.equal(weeklyRent({ price: 2800, period: "M" }), null, "monthly must not be treated as weekly");
  assert.equal(weeklyRent({ price: 34000, period: "A" }), null);
  assert.equal(weeklyRent({ price: 650 }), null, "an unknown period is not weekly");
  assert.equal(weeklyRent({ period: "W" }), null);
});

// ---------------------------------------------------------------------------
// Payload mapping
// ---------------------------------------------------------------------------

function comparablesPayload(items: JsonRecord[]): JsonRecord {
  return { comparablesSummaryList: [{ totalProperties: items.length, propertyComparableList: items }] };
}

function comparableItem(id: number, overrides: JsonRecord = {}): JsonRecord {
  return {
    distanceFromTarget: 0.4,
    comparableForRentPropertyCampaign: { price: 650, period: "W", priceDescription: "$650 per week" },
    property: {
      id,
      propertyType: "UNIT",
      address: { singleLine: `${id} Test Street SYDNEY NSW 2000`, street: { locality: { id: 7 } } },
      attributes: { bedrooms: 2, bathrooms: 1, carSpaces: 1, floorArea: 100 },
      propertyPhotoList: [{ isDefaultPhoto: true, largePhotoUrl: `https://images.corelogic.asia/${id}.jpg` }],
      ...record(overrides.property),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "property")),
  };
}

test("candidates are mapped with real scores, not zero", () => {
  const candidates = candidatesFromComparables(comparablesPayload([comparableItem(2001)]), null, REFERENCE);
  assert.equal(candidates.length, 1);
  const score = record(candidates[0].score);
  assert.ok(Number(score.total) > 0, "the mapped candidate must carry a real score");
  assert.equal(Number(score.total), 100);
});

test("the reference property is never returned as its own comparable", () => {
  const candidates = candidatesFromComparables(
    comparablesPayload([comparableItem(REFERENCE.propertyId), comparableItem(2002)]),
    null,
    REFERENCE,
  );
  assert.deepEqual(candidates.map((item) => item.propertyId), [2002]);
});

test("duplicate property ids are collapsed", () => {
  const candidates = candidatesFromComparables(
    comparablesPayload([comparableItem(2003), comparableItem(2003), comparableItem(2004)]),
    null,
    REFERENCE,
  );
  assert.deepEqual(candidates.map((item) => item.propertyId).sort(), [2003, 2004]);
});

test("invalid property ids are rejected", () => {
  const candidates = candidatesFromComparables(
    comparablesPayload([comparableItem(0), comparableItem(-5), comparableItem(2005)]),
    null,
    REFERENCE,
  );
  assert.deepEqual(candidates.map((item) => item.propertyId), [2005]);
});

test("candidates sort by score then by distance", () => {
  const candidates = candidatesFromComparables(
    comparablesPayload([
      comparableItem(3001, { property: { id: 3001, propertyType: "HOUSE", attributes: { bedrooms: 5 } } }),
      comparableItem(3002, { distanceFromTarget: 2.0 }),
      comparableItem(3003, { distanceFromTarget: 0.1 }),
    ]),
    null,
    REFERENCE,
  );
  // 3003 and 3002 both score highly; the nearer one leads. 3001 is weakest.
  assert.equal(candidates[0].propertyId, 3003);
  assert.equal(candidates.at(-1)!.propertyId, 3001);
});

test("haversine overrides the API distance when both coordinates exist", () => {
  const referenceCoordinate = { latitude: -33.8688, longitude: 151.2093 };
  const candidates = candidatesFromComparables(
    comparablesPayload([
      comparableItem(4001, {
        distanceFromTarget: 99,
        property: { id: 4001, coordinate: { latitude: -33.87, longitude: 151.21 } },
      }),
    ]),
    referenceCoordinate,
    REFERENCE,
  );
  const distance = Number(candidates[0].distanceKm);
  assert.ok(distance < 5, `measured distance should replace the API value, got ${distance}`);
});

test("a malformed payload yields no candidates instead of throwing", () => {
  assert.deepEqual(candidatesFromComparables(null, null, REFERENCE), []);
  assert.deepEqual(candidatesFromComparables({}, null, REFERENCE), []);
  assert.deepEqual(candidatesFromComparables({ comparablesSummaryList: "nope" }, null, REFERENCE), []);
});

test("non-weekly campaign rents are recorded as null weekly rent", () => {
  const candidates = candidatesFromComparables(
    comparablesPayload([
      comparableItem(5001, { comparableForRentPropertyCampaign: { price: 2800, period: "M" } }),
    ]),
    null,
    REFERENCE,
  );
  assert.equal(candidates[0].weeklyRent, null);
});

test("the request body uses rental rule 3 and no valuation field", () => {
  const body = comparablesRequestBody(1234);
  assert.equal(body.propertyId, 1234);
  assert.equal(body.comparablesRuleId, RENTAL_COMPARABLES_RULE_ID);
  assert.equal(body.comparablesRuleId, 3);
  assert.ok(!("targetPropertyValuation" in body), "a rent review must not send a sale valuation");
});

// ---------------------------------------------------------------------------
// Minimum candidate rule
// ---------------------------------------------------------------------------

function scored(id: number, total: number, weeklyRentValue: number | null): JsonRecord {
  return { propertyId: id, weeklyRent: weeklyRentValue, score: { total, breakdown: {} } };
}

test("at least five candidates are returned when five rental comparables exist", () => {
  // All below the quality threshold of 60, so the top-up rule must engage.
  const candidates = [
    scored(1, 55, 600),
    scored(2, 50, 620),
    scored(3, 45, 640),
    scored(4, 40, 610),
    scored(5, 35, 630),
    scored(6, 30, 660),
  ];
  const selected = selectReportCandidates(candidates, selectQualityComparableRents);
  assert.ok(selected.length >= MINIMUM_REPORT_CANDIDATES, `expected at least 5, got ${selected.length}`);
  assert.equal(selected.length, 5, "top-up stops at the minimum");
});

test("high-scoring candidates are used as-is without top-up", () => {
  const candidates = [
    scored(1, 90, 600),
    scored(2, 85, 620),
    scored(3, 80, 640),
    scored(4, 75, 610),
    scored(5, 70, 630),
    scored(6, 65, 660),
  ];
  const selected = selectReportCandidates(candidates, selectQualityComparableRents);
  assert.equal(selected.length, 6, "all qualifying candidates are kept");
});

test("top-up never adds a candidate without a weekly rent", () => {
  const candidates = [scored(1, 55, 600), scored(2, 50, null), scored(3, 45, null)];
  const selected = selectReportCandidates(candidates, selectQualityComparableRents);
  assert.ok(
    selected.every((item) => item.weeklyRent !== null),
    "a candidate with no weekly rent would corrupt the market summary",
  );
});

test("a sparse market returns what exists without inventing candidates", () => {
  const selected = selectReportCandidates([scored(1, 55, 600), scored(2, 50, 620)], selectQualityComparableRents);
  assert.equal(selected.length, 2);
});

// ---------------------------------------------------------------------------
// Market rent summary
// ---------------------------------------------------------------------------

test("market rent low, high and average come from weekly rents only", () => {
  const summary = marketRentSummary([scored(1, 90, 600), scored(2, 85, 700), scored(3, 80, 800), scored(4, 75, null)]);
  assert.deepEqual(summary, { low: 600, high: 800, average: 700, count: 3 });
});

test("market rent is null when no weekly rent is available", () => {
  assert.deepEqual(marketRentSummary([scored(1, 90, null)]), { low: null, high: null, average: null, count: 0 });
});

// ---------------------------------------------------------------------------
// Image enrichment
// ---------------------------------------------------------------------------

test("image enrichment only fetches selected candidates missing an image", async () => {
  const requested: number[] = [];
  const candidates: JsonRecord[] = [
    { propertyId: 1, address: "1 A St", imageUrl: "https://images.corelogic.asia/1.jpg" },
    { propertyId: 2, address: "2 A St", imageUrl: null },
    { propertyId: 3, address: "3 A St", imageUrl: null },
  ];
  const enriched = await enrichCandidateImages(candidates, candidates.slice(0, 2), async (propertyId) => {
    requested.push(propertyId);
    return { propertyPhoto: { largePhotoUrl: `https://images.corelogic.asia/${propertyId}-new.jpg` } };
  });

  assert.deepEqual(requested, [2], "only the selected candidate lacking an image is fetched");
  assert.equal(enriched[1].imageUrl, "https://images.corelogic.asia/2-new.jpg");
  assert.equal(enriched[2].imageUrl, null, "unselected candidates are untouched");
});

test("an enrichment failure leaves the candidate intact", async () => {
  const candidates: JsonRecord[] = [{ propertyId: 9, address: "9 A St", imageUrl: null }];
  const enriched = await enrichCandidateImages(candidates, candidates, async () => {
    throw new Error("street search failed");
  });
  assert.equal(enriched.length, 1, "the comparable must not be dropped");
  assert.equal(enriched[0].imageUrl, null);
});

test("image enrichment respects the concurrency limit", async () => {
  let active = 0;
  let peak = 0;
  const candidates: JsonRecord[] = Array.from({ length: 9 }, (_, index) => ({
    propertyId: index + 1,
    address: `${index + 1} A St`,
    imageUrl: null,
  }));

  await enrichCandidateImages(
    candidates,
    candidates,
    async (propertyId) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { propertyPhoto: { largePhotoUrl: `https://images.corelogic.asia/${propertyId}.jpg` } };
    },
    3,
  );

  assert.ok(peak <= 3, `image enrichment must not exceed 3 concurrent lookups, peaked at ${peak}`);
});
