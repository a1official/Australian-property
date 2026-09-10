/**
 * One unresolvable address must not withhold completed reports.
 *
 * A live job generated 9 of 10 PDFs and emailed none: the tenth row stayed
 * `pending` after repeated failures, and `replyIsDue` treats pending rows as
 * blocking, so the reply was deferred until the job's retry budget ran out.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createLogger } from "../lib/logger";
import type { PropertyReportRecord } from "../lib/db";
import { MAX_ROW_ATTEMPTS, pendingRows, processRows, replyIsDue, reviewRows } from "../lib/worker-core";

const silent = createLogger({}, { minLevel: "error", sink: () => {} });

function row(overrides: Partial<PropertyReportRecord> & { row_number: number }): PropertyReportRecord {
  // The overrides must be spread last, or `attempts` stays 0 and the exhaustion
  // branch is never reached, which silently makes these assertions meaningless.
  return {
    id: `row-${overrides.row_number}`,
    job_id: "job-1",
    original_address: `${overrides.row_number} Test Street SYDNEY NSW 2000`,
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
    ...overrides,
  } as unknown as PropertyReportRecord;
}

/** Fails generation for one nominated row, mirroring the live failure. */
function harness(options: { failFor: Set<number>; message?: string }) {
  const state = new Map<string, { status: string; error: string | null }>();
  const deps = {
    logger: silent,
    readCsv: async () => "",
    matchAddress: async (address: string) => ({
      kind: "exact" as const,
      propertyId: 1000 + Number(address.match(/^(\d+)/)?.[1] ?? 0),
      normalizedAddress: address,
    }),
    generateReport: async (input: { propertyId: number; address: string }) => {
      const rowNumber = Number(input.address.match(/^(\d+)/)?.[1] ?? 0);
      if (options.failFor.has(rowNumber)) {
        throw new Error(options.message ?? "The exact reference property was not found within the bounded street search.");
      }
      return { filename: `report-${input.propertyId}.pdf`, content: Buffer.from("pdf"), emailData: {} };
    },
    uploadReport: async (input: { filename: string }) => ({ pathname: `reports/job-1/${input.filename}` }),
    readReport: async () => "pdf",
    updateRow: async (input: { id: string; status: string; error?: string | null }) => {
      state.set(input.id, { status: input.status, error: input.error ?? null });
    },
    sendReply: async () => {},
    hasSentReply: async () => false,
    recordReply: async () => {},
    markGmailHandled: async () => {},
    transition: async () => {},
    heartbeat: async () => {},
  } as unknown as Parameters<typeof processRows>[1];

  return { deps, state };
}

test("a transient row failure stays pending while retries remain", async () => {
  const { deps, state } = harness({ failFor: new Set([11]) });
  await processRows([row({ row_number: 11, attempts: 0 })], deps);
  assert.equal(state.get("row-11")?.status, "pending", "an early failure must remain retryable");
});

test("a row that exhausts its retries becomes needs_review, not pending", async () => {
  const { deps, state } = harness({ failFor: new Set([11]) });
  // One more attempt reaches the ceiling.
  await processRows([row({ row_number: 11, attempts: MAX_ROW_ATTEMPTS - 1 })], deps);
  assert.equal(state.get("row-11")?.status, "needs_review");
});

test("nine completed reports are no longer blocked by one unresolvable address", async () => {
  const { deps, state } = harness({ failFor: new Set([11]) });
  const rows = [
    ...Array.from({ length: 9 }, (_, index) => row({ row_number: index + 2 })),
    row({ row_number: 11, attempts: MAX_ROW_ATTEMPTS - 1 }),
  ];

  const outcome = await processRows(rows, deps);
  assert.equal(outcome.generated, 9);
  assert.equal(outcome.needsReview, 1, "the exhausted row is parked for review");

  // Rebuild the row set as the worker would re-read it from Neon.
  const afterRows = rows.map((item) => {
    const next = state.get(item.id);
    return next ? ({ ...item, status: next.status, blob_pathname: next.status === "generated" ? `reports/${item.id}.pdf` : null, report_filename: next.status === "generated" ? `${item.id}.pdf` : null } as PropertyReportRecord) : item;
  });

  assert.equal(pendingRows(afterRows).length, 0, "nothing is left blocking the reply");
  assert.equal(reviewRows(afterRows).length, 1);
  assert.equal(replyIsDue(afterRows), true, "the nine finished reports must be deliverable");
});

test("a permanent row error is still failed rather than parked for review", async () => {
  const { deps, state } = harness({
    failFor: new Set([11]),
    message: "Invalid CoreLogic property identifier.",
  });
  await processRows([row({ row_number: 11, attempts: 0 })], deps);
  assert.equal(state.get("row-11")?.status, "failed");
});

test("the retry ceiling stays low enough to bound Cotality usage", () => {
  assert.ok(MAX_ROW_ATTEMPTS <= 3, `MAX_ROW_ATTEMPTS should stay small, got ${MAX_ROW_ATTEMPTS}`);
});
