/**
 * End-to-end flow test with fake Blob, Cotality and Gmail transports.
 *
 * Exercises the full three-address happy path plus the failure modes required
 * by the plan: unmatched address, Cotality 429, Browserless expiry and Gmail
 * send failure — including that a crash mid-run does not duplicate work.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createLogger } from "../lib/logger";
import type { PropertyReportRecord } from "../lib/db";
import { validateCsvAttachment } from "../lib/csv-intake";
import { generatePropertyReport, matchAddress } from "../lib/report-pipeline";
import { deliverReply, handleJobFailure, pendingRows, processRows, replyIsDue } from "../lib/worker-core";

const silent = createLogger({}, { minLevel: "error", sink: () => {} });
const CSV = "address\n1 Alpha Street SYDNEY NSW 2000\n2 Beta Street SYDNEY NSW 2000\n3 Gamma Street SYDNEY NSW 2000\n";
const BASE = "https://example.test";

/** In-memory stand-ins for Neon and the private Blob store. */
function createWorld(options: {
  /** Addresses Cotality cannot resolve at all (no matcher hit, no suggestion). */
  unmatched?: Set<string>;
  /** propertyId -> number of consecutive 429s to emit before succeeding. */
  reportFailures?: Map<number, number>;
  gmailFailures?: number;
} = {}) {
  const blob = new Map<string, string>();
  const rowsById = new Map<string, PropertyReportRecord>();
  const replies: Array<{ status: string; reportCount: number }> = [];
  const emails: Array<{ recipient: string; attachments: string[]; bodyLength: number }> = [];
  const transitions: string[] = [];
  let gmailHandledAt: string | null = null;
  let gmailFailuresLeft = options.gmailFailures ?? 0;
  const reportFailures = options.reportFailures ?? new Map<number, number>();

  const validated = validateCsvAttachment({ fileName: "batch.csv", content: CSV });
  blob.set("parcel-atlas/csv/job-1-secret/batch.csv", CSV);
  validated.addresses.forEach((address, index) => {
    const id = `row-${index}`;
    rowsById.set(id, {
      id,
      job_id: "job-1",
      row_number: address.rowNumber,
      original_address: address.address,
      normalized_address: null,
      property_id: null,
      status: "pending",
      attempts: 0,
      score: null,
      weekly_rent: null,
      report_filename: null,
      blob_pathname: null,
      error: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    } as PropertyReportRecord);
  });

  const propertyIdFor = (address: string) => {
    if (options.unmatched?.has(address)) return 0;
    return ({ "1 Alpha Street SYDNEY NSW 2000": 5001, "2 Beta Street SYDNEY NSW 2000": 5002, "3 Gamma Street SYDNEY NSW 2000": 5003 })[address] ?? 0;
  };

  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    if (url.includes("/api/corelogic/match")) {
      const address = decodeURIComponent(url.split("q=")[1] ?? "");
      const id = propertyIdFor(address);
      return json(200, { matchDetails: id ? { propertyId: id, matchType: "E" } : null });
    }
    if (url.includes("/api/corelogic/search")) {
      const address = decodeURIComponent(url.split("q=")[1] ?? "");
      const id = propertyIdFor(address);
      return json(200, { suggestions: id ? [{ propertyId: id, suggestion: address }] : [] });
    }
    if (url.includes("/comparables")) {
      const propertyId = Number(url.match(/properties\/(\d+)/)?.[1]);
      const remaining = reportFailures.get(propertyId) ?? 0;
      if (remaining > 0) {
        reportFailures.set(propertyId, remaining - 1);
        return json(429, { detail: "CoreLogic returned 429." });
      }
      return json(200, {
        reference: { coordinateAvailable: true },
        candidates: [{ propertyId: 9001, address: "Nearby Street", score: { total: 82, breakdown: {} }, weeklyRent: 690 }],
      });
    }
    if (url.includes("/api/corelogic/properties/")) {
      return json(200, { propertyId: Number(url.match(/properties\/(\d+)/)?.[1]), modules: { core: { data: { propertyType: "HOUSE" } } } });
    }
    if (url.includes("/api/corelogic/image")) return json(404, { detail: "no image" });
    throw new Error(`Unexpected request ${url}`);
  }) as unknown as typeof fetch;

  const clientOptions = { baseUrl: BASE, fetchImpl, timeoutMs: 5_000 };

  const deps = {
    logger: silent,
    readCsv: async (pathname: string) => {
      const content = blob.get(pathname);
      if (!content) throw new Error(`Blob ${pathname} missing`);
      return content;
    },
    matchAddress: (address: string) => matchAddress(address, clientOptions),
    generateReport: (input: { propertyId: number; address: string }) => generatePropertyReport(input, clientOptions),
    uploadReport: async (input: { filename: string; html: string }) => {
      const pathname = `parcel-atlas/reports/job-1-secret/${input.filename}`;
      blob.set(pathname, input.html);
      return { pathname };
    },
    readReport: async (pathname: string) => {
      const content = blob.get(pathname);
      if (!content) throw new Error(`Blob ${pathname} missing`);
      return content;
    },
    updateRow: async (input: Parameters<typeof import("../lib/db").updatePropertyRow>[0]) => {
      const existing = rowsById.get(input.id);
      if (!existing) return;
      rowsById.set(input.id, {
        ...existing,
        status: input.status,
        normalized_address: input.normalizedAddress ?? existing.normalized_address,
        property_id: input.propertyId != null ? String(input.propertyId) : existing.property_id,
        report_filename: input.reportFilename ?? existing.report_filename,
        blob_pathname: input.blobPathname ?? existing.blob_pathname,
        error: input.error ?? null,
        attempts: existing.attempts + (input.incrementAttempts ? 1 : 0),
      } as PropertyReportRecord);
    },
    sendReply: async (input: { recipient: string; subject: string; attachments: Array<{ name: string; mimeType: string; buffer: Buffer }> }) => {
      if (gmailFailuresLeft > 0) {
        gmailFailuresLeft -= 1;
        throw new Error("Gmail Send is disabled; the draft is missing a recipient or attachment.");
      }
      emails.push({ recipient: input.recipient, attachments: input.attachments.map((a) => a.name), bodyLength: input.subject.length });
    },
    hasSentReply: async () => replies.some((reply) => reply.status === "sent"),
    recordReply: async (input: { reportCount: number; status: "sent" | "failed" }) => {
      if (input.status === "sent" && replies.some((reply) => reply.status === "sent")) {
        throw new Error("duplicate sent reply rejected");
      }
      replies.push({ status: input.status, reportCount: input.reportCount });
    },
    markGmailHandled: async () => {
      gmailHandledAt = new Date().toISOString();
    },
    transition: async (input: { status: string }) => {
      transitions.push(input.status);
    },
    heartbeat: async () => {},
  };

  return {
    deps: deps as unknown as Parameters<typeof processRows>[1],
    blob,
    rows: () => [...rowsById.values()].sort((a, b) => a.row_number - b.row_number),
    replies,
    emails,
    transitions,
    gmailHandled: () => gmailHandledAt,
  };
}

const job = { jobId: "job-1", sender: "agent@example.com", subject: "Rent review", blobSecret: "secret" };

test("three exact matches produce three reports and exactly one email", async () => {
  const world = createWorld();

  const outcome = await processRows(world.rows(), world.deps);
  assert.equal(outcome.generated, 3);

  const rows = world.rows();
  assert.equal(replyIsDue(rows), true);

  const reply = await deliverReply(job, rows, world.deps);
  assert.equal(reply.sent, true);

  // Three report blobs plus the source CSV.
  const reportPaths = [...world.blob.keys()].filter((key) => key.includes("/reports/"));
  assert.equal(reportPaths.length, 3, "three reports stored in Blob");
  assert.ok(world.blob.has("parcel-atlas/csv/job-1-secret/batch.csv"), "source CSV retained in Blob");

  assert.equal(world.emails.length, 1, "exactly one reply email");
  assert.deepEqual(world.emails[0].attachments.sort(), [
    "parcel-atlas-5001.html",
    "parcel-atlas-5002.html",
    "parcel-atlas-5003.html",
  ]);
  assert.ok(world.gmailHandled(), "source message marked handled only after sending");
});

test("a crash after two reports resumes only the remaining one and sends one email", async () => {
  // One world throughout, so row state survives the simulated restart exactly
  // as it would in Neon. The third property fails once, then recovers.
  const world = createWorld({ reportFailures: new Map([[5003, 1]]) });

  const firstPass = await processRows(world.rows(), world.deps);
  assert.equal(firstPass.generated, 2, "two reports complete before the crash");
  assert.equal(pendingRows(world.rows()).length, 1, "third row remains pending");
  assert.equal(replyIsDue(world.rows()), false, "reply is deferred while a row is pending");

  const reportsAfterCrash = [...world.blob.keys()].filter((key) => key.includes("/reports/"));
  assert.equal(reportsAfterCrash.length, 2);

  // Restart: the worker re-leases the job and processes the surviving rows.
  const secondPass = await processRows(world.rows(), world.deps);
  assert.equal(secondPass.generated, 1, "only the outstanding report is regenerated");

  const finalRows = world.rows();
  assert.equal(finalRows.filter((row) => row.status === "generated").length, 3);
  assert.equal([...world.blob.keys()].filter((key) => key.includes("/reports/")).length, 3, "no duplicate reports");

  const reply = await deliverReply(job, finalRows, world.deps);
  assert.equal(reply.sent, true);
  assert.equal(world.emails.length, 1, "one email containing all three reports");
  assert.equal(world.emails[0].attachments.length, 3);
});

test("an unmatched address is parked and the other two still complete", async () => {
  const world = createWorld({ unmatched: new Set(["2 Beta Street SYDNEY NSW 2000"]) });

  const outcome = await processRows(world.rows(), world.deps);
  assert.equal(outcome.generated, 2);
  assert.equal(outcome.needsReview, 1);

  const reply = await deliverReply(job, world.rows(), world.deps);
  assert.equal(reply.sent, true, "the reply proceeds with the exact matches");
  assert.equal(world.emails[0].attachments.length, 2);
});

test("a Cotality 429 is retried and then succeeds without duplicating reports", async () => {
  // Fail once for one property, then let it through.
  const world = createWorld({ reportFailures: new Map([[5002, 1]]) });

  const first = await processRows(world.rows(), world.deps);
  assert.equal(first.failed, 1);
  assert.equal(pendingRows(world.rows()).length, 1);

  const second = await processRows(world.rows(), world.deps);
  assert.equal(second.generated, 1, "the retry generates only the failed row");

  const reportPaths = [...world.blob.keys()].filter((key) => key.includes("/reports/"));
  assert.equal(reportPaths.length, 3, "no duplicate report objects after retry");
});

test("a Browserless expiry during reply is retryable and does not mark Gmail handled", async () => {
  const world = createWorld();
  await processRows(world.rows(), world.deps);

  const failing = {
    ...world.deps,
    sendReply: async () => {
      throw new Error("Target closed: Browserless session expired");
    },
  } as typeof world.deps;

  await assert.rejects(() => deliverReply(job, world.rows(), failing));
  assert.equal(world.gmailHandled(), null, "source email not marked handled");
  assert.deepEqual(world.replies.map((reply) => reply.status), ["failed"]);

  await handleJobFailure(new Error("Target closed: Browserless session expired"), 1, world.deps);
  assert.ok(world.transitions.includes("retryable_failed"));

  // The retry then succeeds and still sends exactly one email.
  const reply = await deliverReply(job, world.rows(), world.deps);
  assert.equal(reply.sent, true);
  assert.equal(world.emails.length, 1);
});

test("a Gmail send failure followed by a retry never sends two emails", async () => {
  const world = createWorld({ gmailFailures: 1 });
  await processRows(world.rows(), world.deps);

  await assert.rejects(() => deliverReply(job, world.rows(), world.deps));
  assert.equal(world.emails.length, 0);

  const retry = await deliverReply(job, world.rows(), world.deps);
  assert.equal(retry.sent, true);
  assert.equal(world.emails.length, 1, "exactly one email across failure and retry");

  // A third attempt must be refused by the sent-reply guard.
  const third = await deliverReply(job, world.rows(), world.deps);
  assert.equal(third.sent, false);
  assert.equal(world.emails.length, 1);
});

test("reports stored in Blob are self-contained HTML", async () => {
  const world = createWorld();
  await processRows(world.rows(), world.deps);
  const [, html] = [...world.blob.entries()].find(([key]) => key.includes("/reports/"))!;
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /Parcel Atlas/);
  assert.ok(!/src='https?:/.test(html), "no remote image references");
});
