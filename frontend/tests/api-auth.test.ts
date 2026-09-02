import assert from "node:assert/strict";
import test from "node:test";

import { SESSION_COOKIE, assertJobApiRequest, jobApiConfigured, sessionCookieValue, verifyToken } from "../lib/api-token";

const TOKEN = "test-operator-token-value";

/**
 * Runs `handler` with JOB_API_TOKEN set to `token`. Pass `null` to unset it.
 * `null` rather than `undefined` because an explicit `undefined` argument would
 * trigger the default parameter value instead of clearing the variable.
 */
function withToken<T>(handler: () => T, token: string | null = TOKEN): T {
  const previous = process.env.JOB_API_TOKEN;
  if (token === null) delete process.env.JOB_API_TOKEN;
  else process.env.JOB_API_TOKEN = token;
  try {
    return handler();
  } finally {
    if (previous === undefined) delete process.env.JOB_API_TOKEN;
    else process.env.JOB_API_TOKEN = previous;
  }
}

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/api/gmail/jobs", { headers });
}

test("an unset token fails closed rather than allowing access", () => {
  withToken(() => {
    assert.equal(jobApiConfigured(), false);
    assert.throws(() => assertJobApiRequest(request({ authorization: "Bearer anything" })), /not configured/);
  }, null);
});

test("a missing credential is rejected", () => {
  withToken(() => {
    assert.throws(() => assertJobApiRequest(request()), /Missing or invalid/);
  });
});

test("a wrong bearer token is rejected", () => {
  withToken(() => {
    assert.throws(() => assertJobApiRequest(request({ authorization: "Bearer wrong-token" })), /Missing or invalid/);
  });
});

test("a correct bearer token is accepted", () => {
  withToken(() => {
    assert.doesNotThrow(() => assertJobApiRequest(request({ authorization: `Bearer ${TOKEN}` })));
  });
});

test("the x-job-api-token header is accepted", () => {
  withToken(() => {
    assert.doesNotThrow(() => assertJobApiRequest(request({ "x-job-api-token": TOKEN })));
  });
});

test("a valid session cookie is accepted", () => {
  withToken(() => {
    const cookie = `${SESSION_COOKIE}=${sessionCookieValue()}`;
    assert.doesNotThrow(() => assertJobApiRequest(request({ cookie })));
  });
});

test("a forged session cookie is rejected", () => {
  withToken(() => {
    assert.throws(() => assertJobApiRequest(request({ cookie: `${SESSION_COOKIE}=deadbeef` })), /Missing or invalid/);
  });
});

test("the session cookie value is not the raw token", () => {
  withToken(() => {
    const value = sessionCookieValue();
    assert.ok(!value.includes(TOKEN), "cookie must not leak the operator token");
    assert.match(value, /^[0-9a-f]{64}$/);
  });
});

test("token comparison tolerates differing lengths without throwing", () => {
  withToken(() => {
    assert.equal(verifyToken("short"), false);
    assert.equal(verifyToken(`${TOKEN}-extra-suffix`), false);
    assert.equal(verifyToken(TOKEN), true);
  });
});
