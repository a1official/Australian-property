import assert from "node:assert/strict";
import test from "node:test";

import { MAX_ATTEMPTS, backoffDelayMs, classifyFailure, nextRunAt, shouldRetry } from "../lib/retry-policy";
import { CsvValidationError } from "../lib/csv-intake";

test("Cotality 429 and rate limits are retryable", () => {
  assert.equal(classifyFailure(new Error("CoreLogic returned 429.")), "retryable");
  assert.equal(classifyFailure(new Error("Cotality rate limit exceeded")), "retryable");
});

test("Browserless and network faults are retryable", () => {
  assert.equal(classifyFailure(new Error("WebSocket connection closed")), "retryable");
  assert.equal(classifyFailure(new Error("Target closed")), "retryable");
  assert.equal(classifyFailure(new Error("socket hang up")), "retryable");
  assert.equal(classifyFailure(new Error("Navigation timeout of 30000 ms exceeded")), "retryable");
});

test("validation and entitlement failures are permanent", () => {
  assert.equal(classifyFailure(new CsvValidationError("CSV requires an address column.")), "permanent");
  assert.equal(classifyFailure(new Error("CoreLogic returned 403.")), "permanent");
  assert.equal(classifyFailure(new Error("Sender is not an approved sender.")), "permanent");
});

test("Google challenges map to needs_reauthentication", () => {
  assert.equal(classifyFailure(new Error("Google is showing a security challenge (2FA / CAPTCHA).")), "needs_reauthentication");
  assert.equal(classifyFailure(new Error("Redirected to signin/v2/challenge")), "needs_reauthentication");
  assert.equal(classifyFailure(new Error("Verify it's you to continue")), "needs_reauthentication");
});

test("reauthentication is never retried automatically", () => {
  assert.equal(shouldRetry("needs_reauthentication", 1), false);
  assert.equal(shouldRetry("permanent", 1), false);
});

test("retryable failures stop at the attempt ceiling", () => {
  assert.equal(shouldRetry("retryable", MAX_ATTEMPTS - 1), true);
  assert.equal(shouldRetry("retryable", MAX_ATTEMPTS), false);
});

test("backoff grows monotonically and stays capped", () => {
  const delays = [1, 2, 3, 4, 5, 9].map((attempt) => backoffDelayMs(attempt, () => 0.5));
  for (let index = 1; index < delays.length; index += 1) {
    assert.ok(delays[index] >= delays[index - 1], `delay ${index} should not shrink`);
  }
  assert.ok(delays.at(-1)! <= 15 * 60_000);
});

test("backoff always keeps a minimum spacing regardless of jitter", () => {
  assert.ok(backoffDelayMs(1, () => 0) >= 15_000);
  assert.ok(backoffDelayMs(1, () => 0.999) <= 30_000);
});

test("nextRunAt schedules strictly in the future", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  assert.ok(nextRunAt(1, now, () => 0).getTime() > now.getTime());
});
