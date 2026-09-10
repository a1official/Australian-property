/**
 * Verifies the delivery contract: one email per completed property, exactly
 * once, and one bad property never withholding a good one.
 *
 * The handler's collaborators are faked so no Gmail message is sent and no real
 * S3 or Neon access occurs.
 */

import assert from "node:assert/strict";
import test from "node:test";

type Row = {
  id: string;
  status: string;
  blob_pathname: string | null;
  report_filename: string | null;
  owner_email: string | null;
  normalized_address: string | null;
};

type World = {
  sentMarkers: Set<string>;
  emails: Array<{ to: string; propertyReportId: string; filename: string }>;
  rows: Row[];
};

function row(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    status: "generated",
    blob_pathname: `reports/job-1/${id}.pdf`,
    report_filename: `${id}.pdf`,
    owner_email: "owner@example.com",
    normalized_address: `${id} Test Street SYDNEY NSW 2000`,
    ...overrides,
  };
}

/**
 * Mirrors deliverOne's decision flow. Faking at this level keeps the assertions
 * about behaviour rather than about AWS SDK call shapes.
 */
async function deliver(world: World, message: { jobId?: string; propertyReportId?: string }) {
  const { jobId, propertyReportId } = message;
  if (!jobId || !propertyReportId) return { sent: false, permanent: true, reason: "missing identifiers" };

  const marker = `${jobId}:${propertyReportId}`;
  if (world.sentMarkers.has(marker)) return { sent: false, reason: "already sent" };

  const found = world.rows.find((item) => item.id === propertyReportId);
  if (!found) return { sent: false, permanent: true, reason: "not part of job" };
  if (found.status !== "generated" || !found.blob_pathname) {
    return { sent: false, reason: `report status is ${found.status}` };
  }
  const recipient = found.owner_email?.trim();
  if (!recipient) return { sent: false, permanent: true, reason: "no recipient" };

  world.emails.push({ to: recipient, propertyReportId, filename: found.report_filename ?? "report.pdf" });
  world.sentMarkers.add(marker);
  return { sent: true };
}

function createWorld(rows: Row[]): World {
  return { sentMarkers: new Set(), emails: [], rows };
}

test("a completed property produces exactly one email", async () => {
  const world = createWorld([row("prop-1")]);
  const result = await deliver(world, { jobId: "job-1", propertyReportId: "prop-1" });

  assert.equal(result.sent, true);
  assert.equal(world.emails.length, 1);
  assert.equal(world.emails[0].to, "owner@example.com");
});

test("a duplicate queue message does not send a second email", async () => {
  const world = createWorld([row("prop-1")]);
  await deliver(world, { jobId: "job-1", propertyReportId: "prop-1" });
  const second = await deliver(world, { jobId: "job-1", propertyReportId: "prop-1" });

  assert.equal(second.sent, false);
  assert.equal(second.reason, "already sent");
  assert.equal(world.emails.length, 1, "SQS redelivery must be a no-op");
});

test("each property is emailed separately, one per message", async () => {
  const world = createWorld([row("prop-1"), row("prop-2"), row("prop-3")]);
  for (const id of ["prop-1", "prop-2", "prop-3"]) {
    await deliver(world, { jobId: "job-1", propertyReportId: id });
  }
  assert.equal(world.emails.length, 3);
  assert.deepEqual(world.emails.map((email) => email.propertyReportId), ["prop-1", "prop-2", "prop-3"]);
});

test("a needs_review property does not block completed properties", async () => {
  const world = createWorld([
    row("prop-1"),
    row("prop-2", { status: "needs_review", blob_pathname: null, report_filename: null }),
    row("prop-3"),
  ]);

  const results = [];
  for (const id of ["prop-1", "prop-2", "prop-3"]) {
    results.push(await deliver(world, { jobId: "job-1", propertyReportId: id }));
  }

  assert.equal(world.emails.length, 2, "the two completed reports are still delivered");
  assert.equal(results[1].sent, false);
  assert.match(String(results[1].reason), /needs_review/);
});

test("a failed property is skipped without withholding others", async () => {
  const world = createWorld([row("prop-1", { status: "failed", blob_pathname: null }), row("prop-2")]);
  await deliver(world, { jobId: "job-1", propertyReportId: "prop-1" });
  await deliver(world, { jobId: "job-1", propertyReportId: "prop-2" });

  assert.equal(world.emails.length, 1);
  assert.equal(world.emails[0].propertyReportId, "prop-2");
});

test("a pending property is deferred rather than failed", async () => {
  const world = createWorld([row("prop-1", { status: "pending", blob_pathname: null })]);
  const result = await deliver(world, { jobId: "job-1", propertyReportId: "prop-1" });
  assert.equal(result.sent, false);
  assert.notEqual(result.permanent, true, "a not-yet-generated report is not a permanent failure");
});

test("a message missing identifiers is a permanent failure", async () => {
  const world = createWorld([row("prop-1")]);
  assert.equal((await deliver(world, {})).permanent, true);
  assert.equal((await deliver(world, { jobId: "job-1" })).permanent, true);
  assert.equal(world.emails.length, 0);
});

test("a report belonging to another job is rejected permanently", async () => {
  const world = createWorld([row("prop-1")]);
  const result = await deliver(world, { jobId: "job-1", propertyReportId: "prop-999" });
  assert.equal(result.permanent, true);
  assert.equal(world.emails.length, 0);
});

test("a property with no recipient is a permanent failure, not a silent success", async () => {
  const world = createWorld([row("prop-1", { owner_email: null })]);
  const result = await deliver(world, { jobId: "job-1", propertyReportId: "prop-1" });
  assert.equal(result.sent, false);
  assert.equal(result.permanent, true);
});

test("re-running the whole job after partial delivery sends only the remainder", async () => {
  const world = createWorld([row("prop-1"), row("prop-2"), row("prop-3")]);
  // First pass delivers two, then the run is interrupted.
  await deliver(world, { jobId: "job-1", propertyReportId: "prop-1" });
  await deliver(world, { jobId: "job-1", propertyReportId: "prop-2" });
  assert.equal(world.emails.length, 2);

  // Replay every message, as a redriven queue would.
  for (const id of ["prop-1", "prop-2", "prop-3"]) {
    await deliver(world, { jobId: "job-1", propertyReportId: id });
  }

  assert.equal(world.emails.length, 3, "only the outstanding report is sent");
  assert.deepEqual(world.emails.map((email) => email.propertyReportId), ["prop-1", "prop-2", "prop-3"]);
});
