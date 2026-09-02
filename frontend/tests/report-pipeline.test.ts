import assert from "node:assert/strict";
import test from "node:test";

import { UpstreamError, generatePropertyReport, matchAddress } from "../lib/report-pipeline";

const BASE = "https://example.test";

type Route = (url: string) => { status: number; body: unknown; contentType?: string } | undefined;

function stubFetch(route: Route): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const result = route(url);
    if (!result) throw new Error(`Unexpected request: ${url}`);
    const isImage = (result.contentType ?? "").startsWith("image/");
    const body = isImage ? (result.body as Buffer) : JSON.stringify(result.body);
    return new Response(body as BodyInit, {
      status: result.status,
      headers: { "content-type": result.contentType ?? "application/json" },
    });
  }) as unknown as typeof fetch;
}

test("an exact Address Matcher result is accepted", async () => {
  const outcome = await matchAddress("1 Test Street SYDNEY NSW 2000", {
    baseUrl: BASE,
    fetchImpl: stubFetch((url) => {
      if (url.includes("/match")) return { status: 200, body: { matchDetails: { propertyId: 4242, matchType: "E" } } };
      if (url.includes("/search")) return { status: 200, body: { suggestions: [{ propertyId: 4242, suggestion: "1 TEST STREET SYDNEY NSW 2000" }] } };
      return undefined;
    }),
  });
  assert.deepEqual(outcome, { kind: "exact", propertyId: 4242, normalizedAddress: "1 TEST STREET SYDNEY NSW 2000" });
});

test("an exactly equal suggestion is accepted when the matcher is not definitive", async () => {
  const outcome = await matchAddress("12 Smith St Sydney NSW", {
    baseUrl: BASE,
    fetchImpl: stubFetch((url) => {
      if (url.includes("/match")) return { status: 200, body: { matchDetails: { matchType: "P" } } };
      if (url.includes("/search")) return { status: 200, body: { suggestions: [{ propertyId: 77, suggestion: "12 SMITH STREET SYDNEY NSW" }] } };
      return undefined;
    }),
  });
  assert.equal(outcome.kind, "exact");
});

test("ambiguous suggestions become needs_review rather than a guess", async () => {
  const outcome = await matchAddress("5 Unclear Avenue", {
    baseUrl: BASE,
    fetchImpl: stubFetch((url) => {
      if (url.includes("/match")) return { status: 200, body: { matchDetails: null } };
      if (url.includes("/search")) return { status: 200, body: { suggestions: [{ propertyId: 1, suggestion: "5 UNCLEAR AVENUE UNIT 1" }, { propertyId: 2, suggestion: "5 UNCLEAR AVENUE UNIT 2" }] } };
      return undefined;
    }),
  });
  assert.equal(outcome.kind, "needs_review");
});

test("no candidates at all becomes unmatched", async () => {
  const outcome = await matchAddress("Nowhere", {
    baseUrl: BASE,
    fetchImpl: stubFetch((url) => {
      if (url.includes("/match")) return { status: 200, body: { matchDetails: null } };
      if (url.includes("/search")) return { status: 200, body: { suggestions: [] } };
      return undefined;
    }),
  });
  assert.equal(outcome.kind, "unmatched");
});

test("a Cotality 429 propagates instead of being recorded as unmatched", async () => {
  await assert.rejects(
    () =>
      matchAddress("1 Test Street", {
        baseUrl: BASE,
        fetchImpl: stubFetch(() => ({ status: 429, body: { detail: "CoreLogic returned 429." } })),
      }),
    (error: unknown) => error instanceof UpstreamError && error.status === 429,
  );
});

test("an upstream 502 propagates as retryable", async () => {
  await assert.rejects(
    () =>
      matchAddress("1 Test Street", {
        baseUrl: BASE,
        fetchImpl: stubFetch(() => ({ status: 502, body: { detail: "CoreLogic could not be reached." } })),
      }),
    UpstreamError,
  );
});

test("generatePropertyReport returns a deterministic filename and offline HTML", async () => {
  const result = await generatePropertyReport(
    { propertyId: 4242, address: "1 Test Street SYDNEY NSW 2000" },
    {
      baseUrl: BASE,
      fetchImpl: stubFetch((url) => {
        if (url.includes("/comparables")) {
          return {
            status: 200,
            body: {
              reference: { coordinateAvailable: true },
              candidates: [
                { propertyId: 1, address: "2 Test Street", score: { total: 88, breakdown: {} }, weeklyRent: 700, imageUrl: "https://images.corelogic.asia/c.jpg" },
              ],
            },
          };
        }
        if (url.includes("/api/corelogic/image")) {
          return { status: 200, body: Buffer.from([1, 2, 3, 4]), contentType: "image/jpeg" };
        }
        if (url.includes("/api/corelogic/properties/4242")) {
          return { status: 200, body: { propertyId: 4242, modules: { core: { data: { propertyType: "HOUSE" } } } } };
        }
        return undefined;
      }),
    },
  );

  assert.equal(result.filename, "parcel-atlas-4242.html");
  assert.match(result.html, /data:image\/jpeg;base64,AQIDBA==/);
  assert.ok(!/src='https?:/.test(result.html));
});

test("image failures never fail the report", async () => {
  const result = await generatePropertyReport(
    { propertyId: 7, address: "1 Test Street" },
    {
      baseUrl: BASE,
      fetchImpl: stubFetch((url) => {
        if (url.includes("/comparables")) {
          return { status: 200, body: { reference: {}, candidates: [{ propertyId: 1, address: "2 Test St", score: { total: 90, breakdown: {} }, weeklyRent: 650, imageUrl: "https://images.corelogic.asia/x.jpg" }] } };
        }
        if (url.includes("/api/corelogic/image")) return { status: 502, body: { detail: "image failed" } };
        if (url.includes("/api/corelogic/properties/7")) return { status: 200, body: { modules: {} } };
        return undefined;
      }),
    },
  );
  assert.match(result.html, /Image unavailable/);
});
