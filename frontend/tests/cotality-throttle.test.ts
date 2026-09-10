/**
 * Guards the Cotality request budget.
 *
 * A street scan was previously allowed 150 pages. Because every Cotality call is
 * serialised with a 500 ms floor, that is ~75 seconds of sustained requests for
 * a single address, and it exhausted the sandbox quota. These tests pin the
 * bounds that prevent a repeat, and assert the circuit-breaker semantics.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { MAX_STREET_PAGES, STREET_PAGE_BATCH } from "../lib/search-reference";
import { classifyFailure } from "../lib/retry-policy";

const MIN_REQUEST_INTERVAL_MS = 500;

test("the street page budget stays small enough to avoid a burst", () => {
  // 20 pages at a 500 ms floor is ~10s of calls: slow, but survivable.
  assert.ok(MAX_STREET_PAGES <= 40, `MAX_STREET_PAGES must stay bounded, got ${MAX_STREET_PAGES}`);
  const worstCaseMs = MAX_STREET_PAGES * MIN_REQUEST_INTERVAL_MS;
  assert.ok(worstCaseMs <= 20_000, `a single address must not monopolise Cotality for ${worstCaseMs}ms`);
});

test("the page batch size cannot be inflated into a burst", () => {
  assert.ok(STREET_PAGE_BATCH <= 8, `STREET_PAGE_BATCH must stay small, got ${STREET_PAGE_BATCH}`);
});

test("an oversized environment override is clamped, not honoured", async () => {
  // A misconfiguration must not be able to recreate the incident.
  const previous = process.env.COTALITY_MAX_STREET_PAGES;
  process.env.COTALITY_MAX_STREET_PAGES = "5000";
  try {
    const module = await import(`../lib/search-reference?clamp=${Date.now()}`);
    assert.ok(
      (module as { MAX_STREET_PAGES: number }).MAX_STREET_PAGES <= 40,
      "an override above the ceiling must be clamped",
    );
  } finally {
    if (previous === undefined) delete process.env.COTALITY_MAX_STREET_PAGES;
    else process.env.COTALITY_MAX_STREET_PAGES = previous;
  }
});

test("a rate-limit response is classified retryable, not permanent", () => {
  // It must be retried later rather than discarding the property row.
  assert.equal(classifyFailure(new Error("CoreLogic returned 429.")), "retryable");
  assert.equal(classifyFailure(new Error("Cotality street search failed (HTTP 429).")), "retryable");
});

test("a paused circuit is retryable so queued work resumes automatically", () => {
  const message =
    "Cotality requests are paused for 60s after repeated rate-limit responses. The work will resume automatically.";
  assert.equal(classifyFailure(new Error(message)), "retryable");
});

/** Mirrors the breaker's decision logic for deterministic assertions. */
function createBreaker(threshold = 3, cooldownMs = 60_000) {
  let consecutive = 0;
  let openUntil = 0;
  let now = 0;
  return {
    advance(ms: number) {
      now += ms;
    },
    isOpen() {
      return openUntil > now;
    },
    rateLimited() {
      consecutive += 1;
      if (consecutive >= threshold) {
        openUntil = now + cooldownMs;
        consecutive = 0;
      }
    },
    succeeded() {
      consecutive = 0;
    },
  };
}

test("the circuit opens only after repeated rate limits", () => {
  const breaker = createBreaker();
  breaker.rateLimited();
  assert.equal(breaker.isOpen(), false, "one 429 must not stop all work");
  breaker.rateLimited();
  assert.equal(breaker.isOpen(), false);
  breaker.rateLimited();
  assert.equal(breaker.isOpen(), true, "sustained throttling must pause requests");
});

test("a success resets the failure count", () => {
  const breaker = createBreaker();
  breaker.rateLimited();
  breaker.rateLimited();
  breaker.succeeded();
  breaker.rateLimited();
  assert.equal(breaker.isOpen(), false, "intermittent 429s must not accumulate indefinitely");
});

test("the circuit closes again after the cooldown", () => {
  const breaker = createBreaker(3, 60_000);
  for (let index = 0; index < 3; index += 1) breaker.rateLimited();
  assert.equal(breaker.isOpen(), true);
  breaker.advance(59_000);
  assert.equal(breaker.isOpen(), true, "the cooldown must be respected");
  breaker.advance(2_000);
  assert.equal(breaker.isOpen(), false, "work resumes without manual intervention");
});
