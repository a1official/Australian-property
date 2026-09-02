import assert from "node:assert/strict";
import test from "node:test";

import { buildBrowserlessEndpoint, composeReplyBody, isChallengeUrl } from "../lib/gmail-worker";
import { classifyFailure } from "../lib/retry-policy";
import { redact } from "../lib/logger";

test("endpoint is built from an explicit ws endpoint", () => {
  const endpoint = buildBrowserlessEndpoint({ wsEndpoint: "wss://production-sfo.browserless.io?token=abc" });
  assert.match(endpoint, /^wss:\/\/production-sfo\.browserless\.io\?token=abc&stealth=true/);
});

test("endpoint is derived from an api key when no ws endpoint is set", () => {
  const endpoint = buildBrowserlessEndpoint({ apiKey: "key123" });
  assert.match(endpoint, /token=key123/);
  assert.match(endpoint, /stealth=true/);
});

test("existing stealth settings are not duplicated", () => {
  const endpoint = buildBrowserlessEndpoint({ wsEndpoint: "wss://host?token=a&stealth=false" });
  assert.equal(endpoint.match(/stealth=/g)?.length, 1);
});

test("missing Browserless configuration fails loudly", () => {
  assert.throws(() => buildBrowserlessEndpoint({}), /Browserless is not configured/);
});

test("the endpoint token is redacted in logs", () => {
  const endpoint = buildBrowserlessEndpoint({ apiKey: "supersecretkey" });
  assert.ok(!redact(endpoint).includes("supersecretkey"));
});

test("Google challenge URLs are detected", () => {
  assert.equal(isChallengeUrl("https://accounts.google.com/signin/v2/challenge/pwd"), true);
  assert.equal(isChallengeUrl("https://accounts.google.com/v3/signin/rejected"), true);
  assert.equal(isChallengeUrl("https://mail.google.com/mail/u/0/#inbox"), false);
});

test("a challenge maps to needs_reauthentication and is never retried", () => {
  const error = Object.assign(new Error("Google presented an MFA/CAPTCHA challenge after the password step"), {
    name: "NeedsReauthenticationError",
  });
  assert.equal(classifyFailure(error), "needs_reauthentication");
});

test("reply body is never blank and states the report count", () => {
  const single = composeReplyBody(1);
  assert.ok(single.trim().length > 40);
  assert.match(single, /1 property submitted/);
  assert.match(single, /report for/);

  const many = composeReplyBody(3);
  assert.match(many, /3 properties submitted/);
  assert.match(many, /reports for/);
});

test("reply body keeps the phrase the send guard asserts on", () => {
  assert.match(composeReplyBody(2), /Please find attached your Parcel Atlas property rent review report/);
});
