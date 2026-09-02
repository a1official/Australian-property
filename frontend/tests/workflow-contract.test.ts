/**
 * Guards the contract between the dispatch route and the GitHub workflow.
 *
 * A mismatch here fails only at runtime with an opaque GitHub 422, so the YAML
 * is asserted directly: the workflow must accept workflow_dispatch with a
 * `reason` input, serialise Gmail/Cotality work behind one concurrency group,
 * and run the same entry point as the cron schedule.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflowPath = resolve(process.cwd(), "..", ".github", "workflows", "gmail-report-pipeline.yml");
const workflow = readFileSync(workflowPath, "utf8");

test("the workflow supports both schedule and workflow_dispatch", () => {
  assert.match(workflow, /^\s*schedule:/m, "cron trigger must remain");
  assert.match(workflow, /^\s*workflow_dispatch:/m, "UI dispatch trigger must exist");
});

test("workflow_dispatch accepts the reason input the route sends", () => {
  const dispatchBlock = workflow.slice(workflow.indexOf("workflow_dispatch:"));
  assert.match(dispatchBlock, /inputs:/, "dispatch must declare inputs");
  assert.match(dispatchBlock, /\breason:/, "the route sends inputs.reason");
  // A required input without a default would reject the cron-triggered run.
  const reasonBlock = dispatchBlock.slice(dispatchBlock.indexOf("reason:"), dispatchBlock.indexOf("reason:") + 220);
  assert.match(reasonBlock, /required:\s*false/, "reason must be optional so scheduled runs still work");
});

test("concurrency serialises mailbox runs so repeated clicks cannot overlap", () => {
  assert.match(workflow, /group:\s*parcel-atlas-gmail-worker/);
  // Cancelling would abandon a half-processed job mid-flight.
  assert.match(workflow, /cancel-in-progress:\s*false/);
});

test("a dispatched run executes the same entry point as cron", () => {
  assert.match(workflow, /pnpm worker:scheduled/);
  const runCount = workflow.match(/pnpm worker:scheduled/g)?.length ?? 0;
  assert.equal(runCount, 1, "one shared entry point, not a separate manual path");
});

test("secrets are referenced, never inlined", () => {
  for (const key of [
    "DATABASE_URL",
    "BLOB_READ_WRITE_TOKEN",
    "BROWSERLESS_API_KEY",
    "GMAIL_USERNAME",
    "GMAIL_PASSWORD",
  ]) {
    const pattern = new RegExp(`${key}:\\s*\\$\\{\\{\\s*secrets\\.${key}\\s*\\}\\}`);
    assert.match(workflow, pattern, `${key} must come from repository secrets`);
  }
});

test("no GitHub dispatch token is exposed to the workflow or the browser", () => {
  assert.ok(!workflow.includes("GITHUB_WORKFLOW_DISPATCH_TOKEN"), "the runner never needs the dispatch token");
  assert.ok(!/NEXT_PUBLIC_[A-Z_]*TOKEN/.test(workflow), "no client-exposed token");
});

test("the run is bounded so a stuck browser cannot burn the Actions budget", () => {
  const timeout = workflow.match(/timeout-minutes:\s*(\d+)/);
  assert.ok(timeout, "the job must declare a timeout");
  assert.ok(Number(timeout![1]) <= 30, `timeout should stay modest, got ${timeout![1]} minutes`);
});
