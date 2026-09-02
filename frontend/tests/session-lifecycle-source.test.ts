/**
 * Structural assertions against the real openGmailSession source.
 *
 * The behavioural lifecycle test uses a simulation, which by construction
 * cannot catch a regression in the actual control flow. The specific defect
 * worth guarding is `sessionIsValid` throwing NeedsReauthenticationError for a
 * challenged STORED session, which escapes the function before the bounded
 * credential login is attempted and permanently stalls the pipeline.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(process.cwd(), "lib", "gmail-worker.ts"), "utf8");

/**
 * Extracts a top-level function declaration.
 *
 * Brace matching from the first `{` is wrong here: a return type such as
 * `Promise<{ valid: boolean }>` opens a brace before the body does, which
 * silently yields only the signature and makes every assertion vacuous.
 * These declarations are all top-level, so the body ends at the first
 * column-zero `}`.
 */
function functionBody(name: string): string {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `${name} must exist`);
  const end = source.indexOf("\n}", start);
  assert.ok(end > start, `could not delimit ${name}`);
  const body = source.slice(start, end + 2);
  // Guard the guard: a real body contains statements, not just a signature.
  assert.ok(body.includes("\n"), `${name} body looks empty`);
  return body;
}

test("the source extractor captures a function body, not just its signature", () => {
  const body = functionBody("sessionIsValid");
  // Without this, an assertion like "must not throw" would pass vacuously.
  assert.match(body, /page\.goto/, "the extracted body must contain implementation");
  assert.ok(body.split("\n").length > 5, "the extracted body must span multiple lines");
});

test("the stored-session probe never throws a reauthentication error", () => {
  const body = functionBody("sessionIsValid");
  assert.ok(
    !body.includes("throw new NeedsReauthenticationError"),
    "sessionIsValid must report a challenge, not throw it, or the credential login is skipped",
  );
});

test("the stored-session probe reports whether it was challenged", () => {
  const body = functionBody("sessionIsValid");
  assert.match(body, /challenged/, "the caller needs to distinguish a challenge from a plain failure");
});

test("openGmailSession attempts the credential login after a failed probe", () => {
  const body = functionBody("openGmailSession");
  const probeIndex = body.indexOf("sessionIsValid");
  const loginIndex = body.indexOf("performLogin");
  assert.ok(probeIndex >= 0, "the stored session must be probed");
  assert.ok(loginIndex > probeIndex, "performLogin must come after the probe, as a fallback");
});

test("openGmailSession persists the session on both reuse and login", () => {
  const body = functionBody("openGmailSession");
  const saves = body.match(/saveGmailSession/g)?.length ?? 0;
  // One for the refreshed reuse path, one after a successful login.
  assert.ok(saves >= 2, `expected a save on reuse and after login, found ${saves}`);
});

test("a login failure is recorded before the error propagates", () => {
  const body = functionBody("openGmailSession");
  const failureIndex = body.indexOf("recordLoginFailure");
  const successIndex = body.indexOf("recordLoginSuccess");
  assert.ok(failureIndex >= 0, "failures must feed the login rate limiter");
  assert.ok(successIndex >= 0, "success must clear the login rate limiter");
});

test("the login is gated before credentials are used", () => {
  const body = functionBody("openGmailSession");
  const gateIndex = body.indexOf("checkLoginGate");
  const loginIndex = body.indexOf("performLogin");
  assert.ok(gateIndex >= 0 && gateIndex < loginIndex, "the gate must be checked before logging in");
});

test("a challenge during login is still terminal", () => {
  const body = functionBody("performLogin");
  assert.match(
    body,
    /throw new NeedsReauthenticationError/,
    "performLogin must stop on a Google challenge rather than retrying",
  );
});

test("no CAPTCHA bypass or fingerprint spoofing is attempted", () => {
  for (const forbidden of ["solveCaptcha", "captchaSolver", "2captcha", "anticaptcha", "bypassChallenge"]) {
    assert.ok(!source.toLowerCase().includes(forbidden.toLowerCase()), `${forbidden} must not appear`);
  }
});

test("credentials are never written to logs", () => {
  // Log calls may reference the username field name but never the password value.
  // [\s\S] rather than the `s` flag, which requires an ES2018 target.
  const logCalls = source.match(/logger\.(info|warn|error|debug)\([\s\S]*?\)/g) ?? [];
  for (const call of logCalls) {
    assert.ok(!/config\.password|\bpassword:/.test(call), `log call must not include the password: ${call.slice(0, 80)}`);
  }
});
