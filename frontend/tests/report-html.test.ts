import assert from "node:assert/strict";
import test from "node:test";

import {
  averageWeeklyRentOf,
  buildReportHtml,
  comparableAddress,
  escapeHtml,
  reportFilenameFor,
  selectQualityComparableRents,
} from "../lib/report-html";

function candidate(total: number, weeklyRent: number | null, extra: Record<string, unknown> = {}) {
  return {
    score: { total, breakdown: {} as Record<string, number> },
    weeklyRent,
    propertyId: 1,
    address: "1 Test St",
    ...extra,
  };
}

test("comparables below the score threshold are excluded entirely", () => {
  const result = selectQualityComparableRents([candidate(59, 600), candidate(60, 620)]);
  assert.equal(result.selected.length, 1);
  assert.equal((result.selected[0].score as { total: number }).total, 60);
  assert.equal(result.excluded.length, 0);
});

test("missing or implausible rents are excluded and reported", () => {
  const result = selectQualityComparableRents([
    candidate(80, null),
    candidate(80, 50),
    candidate(80, 99_000),
    candidate(80, 700),
  ]);
  assert.equal(result.selected.length, 1);
  assert.equal(result.excluded.length, 3);
});

test("market outliers are removed once there are at least three valid rents", () => {
  const result = selectQualityComparableRents([
    candidate(80, 600),
    candidate(80, 620),
    candidate(80, 640),
    candidate(80, 9_000),
  ]);
  assert.deepEqual(
    result.selected.map((item) => item.weeklyRent),
    [600, 620, 640],
  );
  assert.equal(result.excluded.length, 1);
});

test("outlier filtering is skipped below three valid rents", () => {
  const result = selectQualityComparableRents([candidate(80, 600), candidate(80, 5_000)]);
  assert.equal(result.selected.length, 2);
});

test("selection is capped at twelve comparables", () => {
  const many = Array.from({ length: 20 }, () => candidate(90, 600));
  assert.equal(selectQualityComparableRents(many).selected.length, 12);
});

test("average weekly rent is null with no qualifying comparables", () => {
  assert.equal(averageWeeklyRentOf([]), null);
  assert.equal(averageWeeklyRentOf([candidate(80, 600), candidate(80, 700)]), 650);
});

test("address normalisation resolves common abbreviations", () => {
  assert.equal(comparableAddress("12 Smith St, Sydney NSW"), comparableAddress("12 SMITH STREET SYDNEY NSW"));
  assert.equal(comparableAddress("4 Oak Rd"), "4 OAK ROAD");
});

test("escapeHtml neutralises injection characters", () => {
  assert.equal(escapeHtml("<script>alert('x')</script>"), "&lt;script&gt;alert(&#039;x&#039;)&lt;/script&gt;");
  assert.equal(escapeHtml(null), "—");
});

test("report filename is derived from the property id", () => {
  assert.equal(reportFilenameFor(12345), "parcel-atlas-12345.html");
});

test("buildReportHtml renders a self-contained document with no unresolved images", async () => {
  const html = await buildReportHtml({
    address: "1 Test Street SYDNEY NSW 2000",
    profile: {
      propertyId: 999,
      modules: {
        core: { data: { propertyType: "HOUSE", beds: 3, baths: 2, carSpaces: 1, landArea: 450 } },
        additional: { data: { floorArea: 180 } },
        location: { data: { singleLine: "1 Test Street SYDNEY NSW 2000", locality: { id: 7, singleLine: "SYDNEY NSW 2000" } } },
        lastSale: { data: { price: 1_250_000, date: "2024-03-01" } },
      },
    },
    comparables: {
      reference: { coordinateAvailable: true },
      candidates: [candidate(85, 700, { propertyId: 1001, address: "2 Test Street SYDNEY" })],
    },
    now: new Date("2026-01-01T00:00:00Z"),
  });

  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<\/body><\/html>$/);
  assert.match(html, /1 Test Street SYDNEY NSW 2000/);
  assert.match(html, /Average weekly rent/);
  assert.match(html, /Haversine/);
  // No remote asset references: the report must render offline as an attachment.
  assert.ok(!/<img[^>]+src='https?:/.test(html), "report must not reference remote images");
});

test("buildReportHtml states when no comparables qualify", async () => {
  const html = await buildReportHtml({
    address: "9 Empty Road SYDNEY",
    profile: { modules: {} },
    comparables: { reference: { coordinateAvailable: false }, candidates: [] },
  });
  assert.match(html, /No comparable properties met the score and rent-quality requirements/);
  assert.match(html, /no usable coordinate/);
});

test("buildReportHtml embeds images through the injected embedder", async () => {
  const html = await buildReportHtml({
    address: "1 Test Street",
    profile: { modules: { images: { data: { defaultImage: { largePhotoUrl: "https://images.corelogic.asia/a.jpg" } } } } },
    comparables: { reference: {}, candidates: [] },
    embedImages: async () => new Map([["https://images.corelogic.asia/a.jpg", "data:image/jpeg;base64,AAAA"]]),
  });
  assert.match(html, /src='data:image\/jpeg;base64,AAAA'/);
});
