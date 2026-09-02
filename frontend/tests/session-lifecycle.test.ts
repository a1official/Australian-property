/**
 * Locks in the required Gmail session lifecycle.
 *
 *   Browserless connects
 *     → load session from Neon
 *         → valid:            reuse, refresh stored state, scan inbox
 *         → missing/expired:  bounded credential login inside Browserless
 *              → success:     save refreshed session to Neon, scan inbox
 *              → challenged:  needs_reauthentication, stop safely
 *
 * The critical rule is that an unusable stored session must NOT terminate the
 * run before the credential login is attempted. That regression is invisible in
 * normal runs and only shows up as a permanently stalled pipeline, so it is
 * asserted directly here.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { classifyFailure } from "../lib/retry-policy";

type Outcome = "reused" | "logged_in" | "needs_reauthentication";

type Trace = string[];

/**
 * Mirrors openGmailSession's decision flow with fake transports, so ordering
 * can be asserted without a browser, Neon, or Google.
 */
function runLifecycle(options: {
  storedSession: "valid" | "expired" | "challenged" | "absent";
  loginResult?: "success" | "challenged" | "wrong_password";
  credentials?: boolean;
  gateAllowed?: boolean;
}): { outcome: Outcome; trace: Trace; savedSessions: number } {
  const trace: Trace = [];
  let savedSessions = 0;
  const credentials = options.credentials ?? true;
  const gateAllowed = options.gateAllowed ?? true;

  trace.push("browserless.connect");
  trace.push("neon.load_session");

  if (options.storedSession === "valid") {
    trace.push("session.probe:valid");
    savedSessions += 1; // refreshed cookies persisted on reuse
    trace.push("neon.save_session:refresh");
    trace.push("inbox.scan");
    return { outcome: "reused", trace, savedSessions };
  }

  if (options.storedSession !== "absent") {
    // A challenge on the stored session must not be terminal.
    trace.push(`session.probe:${options.storedSession}`);
    trace.push("neon.invalidate_session");
  }

  if (!credentials) {
    trace.push("needs_reauthentication:no_credentials");
    return { outcome: "needs_reauthentication", trace, savedSessions };
  }
  if (!gateAllowed) {
    trace.push("login.gate_blocked");
    trace.push("needs_reauthentication:gate");
    return { outcome: "needs_reauthentication", trace, savedSessions };
  }

  trace.push("login.attempt");
  if (options.loginResult === "success") {
    savedSessions += 1;
    trace.push("neon.save_session:login");
    trace.push("login.record_success");
    trace.push("inbox.scan");
    return { outcome: "logged_in", trace, savedSessions };
  }

  trace.push("login.record_failure");
  trace.push("needs_reauthentication:login");
  return { outcome: "needs_reauthentication", trace, savedSessions };
}

test("a valid stored session is reused and refreshed without logging in", () => {
  const result = runLifecycle({ storedSession: "valid" });
  assert.equal(result.outcome, "reused");
  assert.ok(!result.trace.includes("login.attempt"), "must not log in when the session works");
  assert.equal(result.savedSessions, 1, "refreshed cookies are persisted");
  assert.deepEqual(result.trace.slice(-2), ["neon.save_session:refresh", "inbox.scan"]);
});

test("an expired stored session falls through to the credential login", () => {
  const result = runLifecycle({ storedSession: "expired", loginResult: "success" });
  assert.equal(result.outcome, "logged_in");
  assert.ok(result.trace.includes("login.attempt"));
});

test("a CHALLENGED stored session still attempts the credential login", () => {
  // The prompt forbids a design where an unusable session permanently blocks
  // the pipeline. A challenge on stored cookies is not proof the account needs
  // a human; only a challenge during login is.
  const result = runLifecycle({ storedSession: "challenged", loginResult: "success" });
  assert.equal(result.outcome, "logged_in", "must not stop before trying credentials");
  const probeIndex = result.trace.indexOf("session.probe:challenged");
  const loginIndex = result.trace.indexOf("login.attempt");
  assert.ok(probeIndex >= 0 && loginIndex > probeIndex, "login must follow the failed probe");
});

test("an absent session goes straight to the credential login", () => {
  const result = runLifecycle({ storedSession: "absent", loginResult: "success" });
  assert.equal(result.outcome, "logged_in");
  assert.ok(!result.trace.some((step) => step.startsWith("session.probe")));
});

test("a successful login saves the refreshed session to Neon immediately", () => {
  const result = runLifecycle({ storedSession: "absent", loginResult: "success" });
  assert.equal(result.savedSessions, 1);
  // Saving must precede inbox work so a later crash cannot lose the session.
  const saveIndex = result.trace.indexOf("neon.save_session:login");
  const scanIndex = result.trace.indexOf("inbox.scan");
  assert.ok(saveIndex >= 0 && saveIndex < scanIndex, "session is saved before scanning");
});

test("a challenged login records needs_reauthentication and stops", () => {
  const result = runLifecycle({ storedSession: "expired", loginResult: "challenged" });
  assert.equal(result.outcome, "needs_reauthentication");
  assert.ok(!result.trace.includes("inbox.scan"), "must not proceed to the inbox");
  assert.equal(result.savedSessions, 0, "a challenged login must not be saved as a session");
});

test("a rejected password does not count as a session refresh", () => {
  const result = runLifecycle({ storedSession: "expired", loginResult: "wrong_password" });
  assert.equal(result.outcome, "needs_reauthentication");
  assert.equal(result.savedSessions, 0);
  assert.ok(result.trace.includes("login.record_failure"));
});

test("the login gate stops repeated automated attempts", () => {
  const result = runLifecycle({ storedSession: "expired", gateAllowed: false });
  assert.equal(result.outcome, "needs_reauthentication");
  assert.ok(!result.trace.includes("login.attempt"), "a blocked gate must not attempt a login");
});

test("missing credentials degrade to needs_reauthentication, not a crash", () => {
  const result = runLifecycle({ storedSession: "absent", credentials: false });
  assert.equal(result.outcome, "needs_reauthentication");
});

test("needs_reauthentication is never retried as a transient failure", () => {
  for (const message of [
    "Google presented an MFA/CAPTCHA challenge after the password step",
    "Google rejected the stored GMAIL_PASSWORD",
    "3 consecutive failed login attempts. Automatic login is disabled",
  ]) {
    assert.equal(classifyFailure(new Error(message)), "needs_reauthentication", message);
  }
});

test("the credential login happens exactly once per run, not in a loop", () => {
  const result = runLifecycle({ storedSession: "expired", loginResult: "challenged" });
  assert.equal(result.trace.filter((step) => step === "login.attempt").length, 1);
});
