/**
 * Exercises the dispatch route's response contract without a live GitHub call.
 *
 * The route is a thin wrapper, so these assertions focus on what the browser
 * actually receives: 202 on acceptance, a safe message on failure, and no
 * secret material in any response.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DispatchConfigError,
  DispatchFailedError,
  describeDispatchFailure,
  dispatchWorkflow,
} from "../lib/github-dispatch";

const TOKEN = "ghp-route-test-token";

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { GITHUB_WORKFLOW_DISPATCH_TOKEN: TOKEN, ...overrides } as unknown as NodeJS.ProcessEnv;
}

/** Mirrors the route's mapping from helper outcome to HTTP response. */
async function simulateRoute(options: { body: unknown; env: NodeJS.ProcessEnv; fetchImpl: typeof fetch }) {
  try {
    const result = await dispatchWorkflow({
      reason: (options.body as { reason?: unknown } | null)?.reason,
      env: options.env,
      fetchImpl: options.fetchImpl,
    });
    return {
      status: 202,
      body: { ok: true, accepted: true, workflow: result.workflow, ref: result.ref, reason: result.reason },
    };
  } catch (error) {
    if (error instanceof DispatchConfigError || error instanceof DispatchFailedError) {
      return { status: error.status, body: { ok: false, error: error.message } };
    }
    return { status: 500, body: { ok: false, error: "The mailbox run could not be started." } };
  }
}

const accepted = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;

test("a successful dispatch returns 202 accepted", async () => {
  const response = await simulateRoute({
    body: { reason: "Manual UI Auto-pilot request" },
    env: env(),
    fetchImpl: accepted,
  });
  assert.equal(response.status, 202);
  assert.equal(response.body.ok, true);
});

test("an empty body still dispatches with a default reason", async () => {
  const response = await simulateRoute({ body: null, env: env(), fetchImpl: accepted });
  assert.equal(response.status, 202);
  assert.equal((response.body as { reason: string }).reason, "Manual UI Auto-pilot request");
});

test("a missing token returns 503 rather than a server crash", async () => {
  const response = await simulateRoute({
    body: {},
    env: {} as unknown as NodeJS.ProcessEnv,
    fetchImpl: accepted,
  });
  assert.equal(response.status, 503);
  assert.equal(response.body.ok, false);
  assert.match((response.body as { error: string }).error, /GITHUB_WORKFLOW_DISPATCH_TOKEN/);
});

test("an upstream rejection never exposes the token or upstream body", async () => {
  const leaky = (async () =>
    new Response(`{"message":"Bad credentials ${TOKEN}"}`, { status: 401 })) as unknown as typeof fetch;
  const response = await simulateRoute({ body: {}, env: env(), fetchImpl: leaky });

  assert.equal(response.body.ok, false);
  const serialised = JSON.stringify(response.body);
  assert.ok(!serialised.includes(TOKEN), "the token must never reach the client");
  assert.ok(!serialised.includes("Bad credentials"), "the upstream body must not be forwarded");
});

test("every failure description is client-safe", () => {
  for (const status of [401, 403, 404, 422, 500, 503]) {
    assert.ok(!describeDispatchFailure(status).includes(TOKEN));
  }
});

test("the route requires neither an uploaded CSV nor a reply address", async () => {
  // The mailbox run reads the inbox itself; only an optional reason is sent.
  const response = await simulateRoute({ body: { reason: "no csv, no replyTo" }, env: env(), fetchImpl: accepted });
  assert.equal(response.status, 202);
});
