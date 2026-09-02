import assert from "node:assert/strict";
import test from "node:test";

import { createLogger } from "../lib/logger";
import type { PropertyReportRecord } from "../lib/db";
import {
  buildReplySubject,
  deliverReply,
  generatedRows,
  handleJobFailure,
  pendingRows,
  processRows,
  replyIsDue,
  reviewRows,
} from "../lib/worker-core";

const silentLogger = createLogger({}, { minLevel: "error", sink: () => {} });

function row(overrides: Partial<PropertyReportRecord> & { row_number: number }): PropertyReportRecord {
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
  } as PropertyReportRecord;
}

type WorkerDeps = Parameters<typeof processRows>[1];
type MatchResult = Awaited<ReturnType<WorkerDeps["matchAddress"]>>;

type Harness = {
  deps: WorkerDeps;
  calls: {
    matched: string[];
    generated: number[];
    uploaded: string[];
    replies: Array<{ recipient: string; attachments: string[] }>;
    recorded: Array<{ status: string; reportCount: number }>;
    transitions: string[];
    gmailHandled: number;
  };
  rowState: Map<string, Partial<PropertyReportRecord>>;
  replyAlreadySent: { value: boolean };
};

function harness(options: {
  match?: (address: string) => Promise<MatchResult>;
  generate?: (input: { propertyId: number; address: string }) => Promise<{ filename: string; html: string }>;
  sendReply?: () => Promise<void>;
  replyAlreadySent?: boolean;
} = {}): Harness {
  const calls: Harness["calls"] = {
    matched: [],
    generated: [],
    uploaded: [],
    replies: [],
    recorded: [],
    transitions: [],
    gmailHandled: 0,
  };
  const rowState = new Map<string, Partial<PropertyReportRecord>>();
  const replyAlreadySent = { value: options.replyAlreadySent ?? false };

  const deps: WorkerDeps = {
    logger: silentLogger,
    readCsv: async () => "address\n1 Test Street SYDNEY NSW 2000\n",
    matchAddress: async (address: string): Promise<MatchResult> => {
      calls.matched.push(address);
      if (options.match) return options.match(address);
      const id = Number(address.match(/^(\d+)/)?.[1] ?? 1);
      return { kind: "exact", propertyId: 1000 + id, normalizedAddress: address.toUpperCase() };
    },
    generateReport: async (input) => {
      calls.generated.push(input.propertyId);
      if (options.generate) return options.generate(input);
      return { filename: `parcel-atlas-${input.propertyId}.html`, html: "<html>report</html>" };
    },
    uploadReport: async (input) => {
      calls.uploaded.push(input.filename);
      return { pathname: `parcel-atlas/reports/job-1-secret/${input.filename}` };
    },
    readReport: async (pathname) => `<html>${pathname}</html>`,
    updateRow: async (input) => {
      rowState.set(input.id, { ...rowState.get(input.id), ...(input as Partial<PropertyReportRecord>) });
    },
    sendReply: async (input) => {
      if (options.sendReply) await options.sendReply();
      calls.replies.push({ recipient: input.recipient, attachments: input.attachments.map((a) => a.name) });
    },
    hasSentReply: async () => replyAlreadySent.value,
    recordReply: async (input) => {
      calls.recorded.push({ status: input.status, reportCount: input.reportCount });
      if (input.status === "sent") replyAlreadySent.value = true;
    },
    markGmailHandled: async () => {
      calls.gmailHandled += 1;
    },
    transition: async (input) => {
      calls.transitions.push(input.status);
    },
    heartbeat: async () => {},
  };

  return { deps, calls, rowState, replyAlreadySent };
}

test("row partitioning distinguishes pending, generated and review rows", () => {
  const rows = [
    row({ row_number: 2, status: "generated", blob_pathname: "p/1.html" }),
    row({ row_number: 3, status: "pending" }),
    row({ row_number: 4, status: "needs_review" }),
    row({ row_number: 5, status: "unmatched" }),
  ];
  assert.equal(pendingRows(rows).length, 1);
  assert.equal(generatedRows(rows).length, 1);
  assert.equal(reviewRows(rows).length, 2);
});

test("a generated row without a Blob pathname is not treated as complete", () => {
  assert.equal(generatedRows([row({ row_number: 2, status: "generated", blob_pathname: null })]).length, 0);
});

test("processRows generates a report for every exact match", async () => {
  const h = harness();
  const rows = [row({ row_number: 2 }), row({ row_number: 3 })];
  const result = await processRows(rows, h.deps);
  assert.equal(result.generated, 2);
  assert.equal(h.calls.uploaded.length, 2);
});

test("crash resume regenerates only the remaining three of five reports", async () => {
  const h = harness();
  const rows = [
    row({ row_number: 2, status: "generated", blob_pathname: "p/a.html", report_filename: "a.html" }),
    row({ row_number: 3, status: "generated", blob_pathname: "p/b.html", report_filename: "b.html" }),
    row({ row_number: 4 }),
    row({ row_number: 5 }),
    row({ row_number: 6 }),
  ];

  const result = await processRows(rows, h.deps);

  assert.equal(result.generated, 3, "only the three incomplete rows are generated");
  assert.equal(h.calls.generated.length, 3);
  assert.deepEqual(h.calls.matched.length, 3, "already-completed rows are not re-matched");
  assert.ok(!h.calls.uploaded.includes("a.html"), "completed reports are not re-uploaded");
});

test("an already-matched row is not re-matched, only regenerated", async () => {
  const h = harness();
  await processRows([row({ row_number: 2, status: "matched", property_id: "555", normalized_address: "1 TEST ST" })], h.deps);
  assert.equal(h.calls.matched.length, 0);
  assert.deepEqual(h.calls.generated, [555]);
});

test("ambiguous rows are parked as needs_review and never generated", async () => {
  const h = harness({ match: async (): Promise<MatchResult> => ({ kind: "needs_review", reason: "two candidates" }) });
  const result = await processRows([row({ row_number: 2 })], h.deps);
  assert.equal(result.needsReview, 1);
  assert.equal(h.calls.generated.length, 0);
  assert.equal(h.rowState.get("row-2")?.status, "needs_review");
});

test("an unmatched address is recorded without blocking other rows", async () => {
  const h = harness({
    match: async (address): Promise<MatchResult> =>
      address.startsWith("2")
        ? { kind: "unmatched", reason: "no candidate" }
        : { kind: "exact", propertyId: 900, normalizedAddress: address },
  });
  const result = await processRows([row({ row_number: 2 }), row({ row_number: 3 })], h.deps);
  assert.equal(result.needsReview, 1);
  assert.equal(result.generated, 1);
});

test("a Cotality 429 leaves the row pending for retry, not failed", async () => {
  const h = harness({
    generate: async () => {
      throw new Error("CoreLogic returned 429.");
    },
  });
  const result = await processRows([row({ row_number: 2 })], h.deps);
  assert.equal(result.failed, 1);
  assert.equal(h.rowState.get("row-2")?.status, "pending", "transient failure must stay retryable");
});

test("a permanent row error is marked failed and not retried", async () => {
  const h = harness({
    generate: async () => {
      throw new Error("Invalid CoreLogic property identifier.");
    },
  });
  await processRows([row({ row_number: 2 })], h.deps);
  assert.equal(h.rowState.get("row-2")?.status, "failed");
});

test("a reauthentication error aborts row processing immediately", async () => {
  const h = harness({
    generate: async () => {
      throw new Error("Google presented a security challenge (2FA / CAPTCHA).");
    },
  });
  await assert.rejects(() => processRows([row({ row_number: 2 }), row({ row_number: 3 })], h.deps));
  assert.equal(h.calls.generated.length, 1, "processing stops at the first challenge");
});

test("reply is due only when nothing is pending and something was generated", () => {
  assert.equal(replyIsDue([row({ row_number: 2, status: "generated", blob_pathname: "p" })]), true);
  assert.equal(replyIsDue([row({ row_number: 2, status: "generated", blob_pathname: "p" }), row({ row_number: 3 })]), false);
  assert.equal(replyIsDue([row({ row_number: 2, status: "needs_review" })]), false);
});

test("deliverReply attaches every completed report", async () => {
  const h = harness();
  const rows = [
    row({ row_number: 2, status: "generated", blob_pathname: "p/a.html", report_filename: "parcel-atlas-1.html" }),
    row({ row_number: 3, status: "generated", blob_pathname: "p/b.html", report_filename: "parcel-atlas-2.html" }),
    row({ row_number: 4, status: "generated", blob_pathname: "p/c.html", report_filename: "parcel-atlas-3.html" }),
  ];
  const result = await deliverReply({ jobId: "job-1", sender: "agent@example.com", subject: "Rent review", blobSecret: "s" }, rows, h.deps);

  assert.equal(result.sent, true);
  assert.equal(h.calls.replies.length, 1, "exactly one email");
  assert.deepEqual(h.calls.replies[0].attachments, [
    "parcel-atlas-1.html",
    "parcel-atlas-2.html",
    "parcel-atlas-3.html",
  ]);
  assert.equal(h.calls.gmailHandled, 1, "source message marked handled after send");
});

test("deliverReply refuses to send twice for the same job", async () => {
  const h = harness();
  const rows = [row({ row_number: 2, status: "generated", blob_pathname: "p/a.html", report_filename: "a.html" })];
  const job = { jobId: "job-1", sender: "agent@example.com", subject: "Rent review", blobSecret: "s" };

  const first = await deliverReply(job, rows, h.deps);
  const second = await deliverReply(job, rows, h.deps);

  assert.equal(first.sent, true);
  assert.equal(second.sent, false);
  assert.equal(h.calls.replies.length, 1, "no duplicate email on re-run");
});

test("deliverReply waits while any report is still pending", async () => {
  const h = harness();
  const result = await deliverReply(
    { jobId: "job-1", sender: "a@b.com", subject: "s", blobSecret: "s" },
    [row({ row_number: 2, status: "generated", blob_pathname: "p" }), row({ row_number: 3, status: "pending" })],
    h.deps,
  );
  assert.equal(result.sent, false);
  assert.equal(h.calls.replies.length, 0);
});

test("a Gmail send failure is recorded and does not mark the message handled", async () => {
  const h = harness({
    sendReply: async () => {
      throw new Error("Gmail Send is disabled; the draft is missing a recipient or attachment.");
    },
  });
  await assert.rejects(() =>
    deliverReply(
      { jobId: "job-1", sender: "a@b.com", subject: "s", blobSecret: "s" },
      [row({ row_number: 2, status: "generated", blob_pathname: "p/a.html", report_filename: "a.html" })],
      h.deps,
    ),
  );
  assert.deepEqual(h.calls.recorded, [{ status: "failed", reportCount: 1 }]);
  assert.equal(h.calls.gmailHandled, 0, "unsent reply must not mark the source email handled");
});

test("reply subject is prefixed once and states the report count", () => {
  assert.equal(buildReplySubject("Rent review", 3), "Re: Rent review — Parcel Atlas reports (3)");
  assert.equal(buildReplySubject("Re: Re: Rent review", 1), "Re: Rent review — Parcel Atlas reports (1)");
  assert.match(buildReplySubject("", 2), /Property rent review/);
});

test("job failure schedules a bounded retry for transient errors", async () => {
  const h = harness();
  await handleJobFailure(new Error("Browserless WebSocket closed"), 1, h.deps);
  assert.deepEqual(h.calls.transitions, ["retryable_failed"]);
});

test("job failure stops permanently once the retry budget is exhausted", async () => {
  const h = harness();
  await handleJobFailure(new Error("Browserless WebSocket closed"), 5, h.deps);
  assert.deepEqual(h.calls.transitions, ["failed"]);
});

test("a Google challenge parks the job as needs_reauthentication", async () => {
  const h = harness();
  await handleJobFailure(new Error("Verify it's you to continue"), 1, h.deps);
  assert.deepEqual(h.calls.transitions, ["needs_reauthentication"]);
});

test("a permanent validation error is never retried", async () => {
  const h = harness();
  await handleJobFailure(Object.assign(new Error("CSV requires an address column."), { permanent: true }), 1, h.deps);
  assert.deepEqual(h.calls.transitions, ["failed"]);
});
