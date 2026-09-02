/**
 * Covers the GitHub workflow-dispatch helper: request shape, the 204 success
 * path, missing configuration, and safe handling of upstream failures.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DispatchConfigError,
  DispatchFailedError,
  describeDispatchFailure,
  dispatchWorkflow,
  readDispatchConfig,
  sanitizeReason,
  workflowDispatchUrl,
} from "../lib/github-dispatch";

const TOKEN = "ghp-test-token-value-not-real";

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { GITHUB_WORKFLOW_DISPATCH_TOKEN: TOKEN, ...overrides } as unknown as NodeJS.ProcessEnv;
}

type Captured = { url: string; init: RequestInit };

function captureFetch(status: number, body = ""): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    // 204 must carry no body, mirroring GitHub.
    return status === 204 ? new Response(null, { status: 204 }) : new Response(body, { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test("configuration defaults to this repository and workflow", () => {
  const config = readDispatchConfig(env());
  assert.equal(config.owner, "a1official");
  assert.equal(config.repo, "Australian-property");
  assert.equal(config.workflow, "gmail-report-pipeline.yml");
  assert.equal(config.ref, "main");
});

test("configuration honours environment overrides", () => {
  const config = readDispatchConfig(
    env({ GITHUB_REPOSITORY_OWNER: "other", GITHUB_REPOSITORY_NAME: "repo", GITHUB_GMAIL_WORKFLOW_FILE: "custom.yml" }),
  );
  assert.equal(config.owner, "other");
  assert.equal(config.repo, "repo");
  assert.equal(config.workflow, "custom.yml");
});

test("a missing dispatch token fails closed with an actionable message", () => {
  assert.throws(
    () => readDispatchConfig({} as unknown as NodeJS.ProcessEnv),
    (error: unknown) =>
      error instanceof DispatchConfigError &&
      /GITHUB_WORKFLOW_DISPATCH_TOKEN/.test(error.message) &&
      error.status === 503,
  );
});

test("the dispatch URL targets the documented REST endpoint", () => {
  assert.equal(
    workflowDispatchUrl({ owner: "a1official", repo: "Australian-property", workflow: "gmail-report-pipeline.yml" }),
    "https://api.github.com/repos/a1official/Australian-property/actions/workflows/gmail-report-pipeline.yml/dispatches",
  );
});

test("204 No Content is treated as accepted", async () => {
  const { fetchImpl, calls } = captureFetch(204);
  const result = await dispatchWorkflow({ reason: "Manual UI Auto-pilot request", env: env(), fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(result.workflow, "gmail-report-pipeline.yml");
  assert.equal(calls.length, 1);
});

test("the request carries the correct method, headers, ref and reason", async () => {
  const { fetchImpl, calls } = captureFetch(204);
  await dispatchWorkflow({ reason: "Manual UI Auto-pilot request", env: env(), fetchImpl });

  const [call] = calls;
  assert.equal(call.url, "https://api.github.com/repos/a1official/Australian-property/actions/workflows/gmail-report-pipeline.yml/dispatches");
  assert.equal(call.init.method, "POST");

  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers.Accept, "application/vnd.github+json");
  assert.equal(headers["X-GitHub-Api-Version"], "2022-11-28");
  assert.equal(headers.Authorization, `Bearer ${TOKEN}`);

  assert.deepEqual(JSON.parse(String(call.init.body)), {
    ref: "main",
    inputs: { reason: "Manual UI Auto-pilot request" },
  });
});

test("a non-204 response fails without echoing the upstream body", async () => {
  // A GitHub error body can contain request content; it must not reach the UI.
  const secretish = `{"message":"Bad credentials for ${TOKEN}"}`;
  const { fetchImpl } = captureFetch(401, secretish);

  await assert.rejects(
    () => dispatchWorkflow({ reason: "x", env: env(), fetchImpl }),
    (error: unknown) => {
      assert.ok(error instanceof DispatchFailedError);
      assert.ok(!error.message.includes(TOKEN), "must not leak the token");
      assert.ok(!error.message.includes("Bad credentials for"), "must not echo the upstream body");
      return true;
    },
  );
});

test("a 200 response is rejected, since only 204 means accepted", async () => {
  const { fetchImpl } = captureFetch(200, "{}");
  await assert.rejects(() => dispatchWorkflow({ env: env(), fetchImpl }), DispatchFailedError);
});

test("a network failure is reported safely", async () => {
  const fetchImpl = (async () => {
    throw new Error("getaddrinfo ENOTFOUND api.github.com");
  }) as unknown as typeof fetch;

  await assert.rejects(
    () => dispatchWorkflow({ env: env(), fetchImpl }),
    (error: unknown) =>
      error instanceof DispatchFailedError && /could not be reached/.test(error.message) && !error.message.includes(TOKEN),
  );
});

test("failure descriptions are actionable and secret-free", () => {
  for (const status of [401, 403, 404, 422, 500]) {
    const message = describeDispatchFailure(status);
    assert.ok(message.length > 20, `status ${status} needs a useful message`);
    assert.ok(!message.includes(TOKEN));
  }
  assert.match(describeDispatchFailure(403), /Actions write access/);
});

test("the reason is bounded and single-line", () => {
  assert.equal(sanitizeReason("line one\nline two"), "line one line two");
  assert.equal(sanitizeReason(""), "Manual UI Auto-pilot request");
  assert.equal(sanitizeReason(undefined), "Manual UI Auto-pilot request");
  assert.ok(sanitizeReason("x".repeat(500)).length <= 200);
});

test("a hostile reason cannot inject extra dispatch inputs", async () => {
  const { fetchImpl, calls } = captureFetch(204);
  await dispatchWorkflow({ reason: { ref: "attacker-branch" }, env: env(), fetchImpl });
  const payload = JSON.parse(String(calls[0].init.body)) as { ref: string; inputs: { reason: string } };
  assert.equal(payload.ref, "main", "ref is server-controlled");
  assert.equal(payload.inputs.reason, "Manual UI Auto-pilot request");
});
