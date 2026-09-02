#!/usr/bin/env tsx
/**
 * Integration verification against the real Neon database.
 *
 * Proves the durability guarantees that unit tests with fakes cannot:
 *   1. idempotent job registration
 *   2. transactional single-worker leasing
 *   3. lease expiry reclaim
 *   4. database-level duplicate-reply prevention
 *   5. per-row resume state
 *
 * Creates verification rows with a unique prefix and removes them afterwards.
 *
 *   pnpm tsx scripts/verify-durability.ts
 */

import { randomBytes } from "node:crypto";

import {
  claimNextJob,
  closePool,
  getPool,
  hasSentReply,
  listPropertyRows,
  recordReplyAttempt,
  registerJobWithAttachment,
  seedPropertyRows,
  transitionJob,
  updatePropertyRow,
} from "../lib/db";
import { buildIdempotencyKey } from "../lib/csv-intake";

const RUN = randomBytes(4).toString("hex");
const jobId = `job-verify-${RUN}`;
const results: Array<{ name: string; pass: boolean; detail: string }> = [];

function check(name: string, pass: boolean, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const csv = "address\n1 Verify Street SYDNEY NSW 2000\n2 Verify Street SYDNEY NSW 2000\n3 Verify Street SYDNEY NSW 2000\n";

async function cleanup(): Promise<void> {
  await getPool().query("DELETE FROM pipeline_jobs WHERE id LIKE $1", [`job-verify-${RUN}%`]);
  await getPool().query("DELETE FROM worker_heartbeats WHERE worker_id LIKE $1", [`verify-${RUN}%`]);
}

async function run(): Promise<void> {
  await cleanup();

  const key = buildIdempotencyKey({ sender: "verify@example.com", threadId: `thread-${RUN}`, fileName: "verify.csv", csvContent: csv });
  const attachment = {
    id: `csv-verify-${RUN}`,
    filename: "verify.csv",
    fileHash: "verifyhash",
    rowCount: 3,
    byteSize: Buffer.byteLength(csv),
    blobPathname: `parcel-atlas/csv/${jobId}-secret/verify.csv`,
  };

  // 1. Idempotent registration
  const first = await registerJobWithAttachment({ jobId, idempotencyKey: key, sender: "verify@example.com", subject: "Verify", threadId: `thread-${RUN}`, attachment });
  const second = await registerJobWithAttachment({ jobId: `${jobId}-dup`, idempotencyKey: key, sender: "verify@example.com", subject: "Verify", threadId: `thread-${RUN}`, attachment: { ...attachment, id: `csv-verify-${RUN}-dup` } });
  check("idempotent registration returns the same job", first.created && !second.created && first.job.id === second.job.id, `created=${first.created}/${second.created}`);

  const attachmentCount = await getPool().query<{ n: string }>("SELECT COUNT(*)::text AS n FROM csv_attachments WHERE job_id = $1", [jobId]);
  check("duplicate registration does not add a second attachment", attachmentCount.rows[0].n === "1", `count=${attachmentCount.rows[0].n}`);

  await seedPropertyRows(jobId, [
    { id: `prop-${RUN}-2`, rowNumber: 2, address: "1 Verify Street SYDNEY NSW 2000" },
    { id: `prop-${RUN}-3`, rowNumber: 3, address: "2 Verify Street SYDNEY NSW 2000" },
    { id: `prop-${RUN}-4`, rowNumber: 4, address: "3 Verify Street SYDNEY NSW 2000" },
  ]);
  // Re-seeding must not duplicate rows (crash-resume safety).
  await seedPropertyRows(jobId, [{ id: `prop-${RUN}-2b`, rowNumber: 2, address: "1 Verify Street SYDNEY NSW 2000" }]);
  const rows = await listPropertyRows(jobId);
  check("re-seeding is idempotent per CSV row", rows.length === 3, `rows=${rows.length}`);

  // 2. Only one of two concurrent workers may claim the job
  const [claimA, claimB] = await Promise.all([
    claimNextJob(`verify-${RUN}-a`, 900),
    claimNextJob(`verify-${RUN}-b`, 900),
  ]);
  const claimedOurs = [claimA, claimB].filter((job) => job?.id === jobId);
  check("exactly one worker claims a job", claimedOurs.length === 1, `claims=${claimedOurs.length}`);

  const thirdClaim = await claimNextJob(`verify-${RUN}-c`, 900);
  check("a leased job is not re-claimable", thirdClaim?.id !== jobId, `got=${thirdClaim?.id ?? "none"}`);

  // 3. Expired leases are reclaimed so a crashed worker cannot strand a job
  await getPool().query("UPDATE pipeline_jobs SET lease_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [jobId]);
  const reclaimed = await claimNextJob(`verify-${RUN}-d`, 900);
  check("an expired lease is reclaimable", reclaimed?.id === jobId, `worker=${reclaimed?.leased_by ?? "none"}`);
  check("claiming increments the attempt counter", (reclaimed?.attempts ?? 0) >= 2, `attempts=${reclaimed?.attempts}`);

  // 4. Per-row resume state
  await updatePropertyRow({ id: `prop-${RUN}-2`, status: "generated", propertyId: 111, reportFilename: "parcel-atlas-111.html", blobPathname: "parcel-atlas/reports/x/parcel-atlas-111.html" });
  await updatePropertyRow({ id: `prop-${RUN}-3`, status: "needs_review", error: "ambiguous" });
  const afterUpdate = await listPropertyRows(jobId);
  const generated = afterUpdate.filter((row) => row.status === "generated").length;
  const pending = afterUpdate.filter((row) => row.status === "pending").length;
  check("row-level state distinguishes generated from pending", generated === 1 && pending === 1, `generated=${generated} pending=${pending}`);

  // 5. The database itself must reject a second successful reply
  await recordReplyAttempt({ id: `reply-${RUN}-1`, jobId, recipient: "verify@example.com", reportCount: 1, status: "sent" });
  check("hasSentReply detects the confirmed reply", await hasSentReply(jobId));

  let duplicateRejected = false;
  try {
    await recordReplyAttempt({ id: `reply-${RUN}-2`, jobId, recipient: "verify@example.com", reportCount: 1, status: "sent" });
  } catch {
    duplicateRejected = true;
  }
  check("a second sent reply is rejected by the unique index", duplicateRejected);

  // A failed attempt must still be recordable for audit.
  let failedRecorded = true;
  try {
    await recordReplyAttempt({ id: `reply-${RUN}-3`, jobId, recipient: "verify@example.com", reportCount: 1, status: "failed", error: "transient" });
  } catch {
    failedRecorded = false;
  }
  check("failed reply attempts remain auditable", failedRecorded);

  // 6. Transitions are journalled
  await transitionJob({ jobId, status: "completed", workerId: `verify-${RUN}`, detail: "verification", releaseLease: true });
  const events = await getPool().query<{ n: string }>("SELECT COUNT(*)::text AS n FROM job_events WHERE job_id = $1", [jobId]);
  check("state transitions are journalled", Number(events.rows[0].n) >= 3, `events=${events.rows[0].n}`);

  const finalJob = await getPool().query<{ status: string; leased_by: string | null }>("SELECT status, leased_by FROM pipeline_jobs WHERE id = $1", [jobId]);
  check("completing the job releases the lease", finalJob.rows[0].status === "completed" && finalJob.rows[0].leased_by === null);

  const stillClaimable = await claimNextJob(`verify-${RUN}-e`, 900);
  check("a completed job is never re-claimed", stillClaimable?.id !== jobId, `got=${stillClaimable?.id ?? "none"}`);
  if (stillClaimable) {
    await transitionJob({ jobId: stillClaimable.id, status: stillClaimable.status, detail: "released by verification", releaseLease: true });
  }
}

void run()
  .then(async () => {
    await cleanup();
    const failed = results.filter((result) => !result.pass);
    console.log(`\n${results.length - failed.length}/${results.length} durability checks passed.`);
    await closePool();
    process.exit(failed.length ? 1 : 0);
  })
  .catch(async (error: unknown) => {
    console.error("verification error:", error instanceof Error ? error.message : String(error));
    await cleanup().catch(() => undefined);
    await closePool();
    process.exit(1);
  });
