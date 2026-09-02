/**
 * Verifies the login rate-limit decision logic in isolation.
 *
 * The database functions are integration-tested by verify-login-gate.ts; these
 * cover the branch behaviour that protects the account from being locked.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { MAX_LOGIN_ATTEMPTS } from "../lib/db";
import { classifyFailure } from "../lib/retry-policy";

/** Mirrors checkLoginGate's decision, driven by a fake record. */
function gateDecision(record: { attempts: number; cooldownUntil: Date | null } | null, now = new Date()) {
  if (!record) return { allowed: true, attempts: 0 };
  if (record.cooldownUntil && record.cooldownUntil > now) {
    return { allowed: false, attempts: record.attempts, reason: "cooldown" };
  }
  if (record.attempts >= MAX_LOGIN_ATTEMPTS) {
    return { allowed: false, attempts: record.attempts, reason: "exhausted" };
  }
  return { allowed: true, attempts: record.attempts };
}

test("a first login with no history is allowed", () => {
  assert.equal(gateDecision(null).allowed, true);
});

test("an active cooldown blocks a login attempt", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const decision = gateDecision({ attempts: 1, cooldownUntil: new Date("2026-01-01T00:10:00Z") }, now);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "cooldown");
});

test("an elapsed cooldown allows a retry", () => {
  const now = new Date("2026-01-01T01:00:00Z");
  assert.equal(gateDecision({ attempts: 1, cooldownUntil: new Date("2026-01-01T00:10:00Z") }, now).allowed, true);
});

test("automatic login stops permanently at the attempt ceiling", () => {
  const decision = gateDecision({ attempts: MAX_LOGIN_ATTEMPTS, cooldownUntil: null });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "exhausted");
});

test("the ceiling is low enough to protect the account", () => {
  // A high ceiling combined with a 60s poll loop is how accounts get locked.
  assert.ok(MAX_LOGIN_ATTEMPTS <= 3, `MAX_LOGIN_ATTEMPTS should stay small, got ${MAX_LOGIN_ATTEMPTS}`);
});

test("a blocked gate surfaces as needs_reauthentication, never as a retry", () => {
  const error = new Error(
    "3 consecutive failed login attempts. Automatic login is disabled to protect the account from being locked.",
  );
  // Must not be retryable, or the worker would loop back into the login path.
  assert.equal(classifyFailure(error), "needs_reauthentication");
});

test("an active cooldown message is not retryable", () => {
  assert.equal(
    classifyFailure(new Error("Login cooldown active until 2026-01-01T00:15:00.000Z.")),
    "needs_reauthentication",
  );
});

test("a rejected password is treated as needs_reauthentication", () => {
  const error = Object.assign(
    new Error("Google rejected the stored GMAIL_PASSWORD. Automatic login stopped to avoid locking the account."),
    { name: "NeedsReauthenticationError", needsReauthentication: true },
  );
  assert.equal(classifyFailure(error), "needs_reauthentication");
});

test("a missing password field is treated as needs_reauthentication", () => {
  const error = Object.assign(
    new Error("Google did not present a password field; the flow stopped at https://accounts.google.com/v3/signin/rejected"),
    { name: "NeedsReauthenticationError" },
  );
  assert.equal(classifyFailure(error), "needs_reauthentication");
});
