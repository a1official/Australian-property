#!/usr/bin/env tsx
/** Read-only view of one job: rows, replies and the transition history. */

import { closePool, getJobDetails } from "../lib/db";

async function run(): Promise<void> {
  const jobId = process.argv[2];
  if (!jobId) throw new Error("usage: inspect-job.ts <jobId>");

  const details = await getJobDetails(jobId);
  if (!details) throw new Error(`Job ${jobId} not found.`);

  const { job } = details;
  console.log(`\njob:       ${job.id}`);
  console.log(`status:    ${job.status}`);
  console.log(`sender:    ${job.sender}`);
  console.log(`attempts:  ${job.attempts}`);
  console.log(`error:     ${job.error ?? "(none)"}`);
  console.log(`created:   ${job.created_at}`);

  console.log(`\nproperty rows: ${details.reports.length}`);
  for (const report of details.reports) {
    const parts = [
      `row ${String(report.row_number).padEnd(3)}`,
      report.status.padEnd(13),
      (report.report_filename ?? "-").padEnd(46),
      report.original_address,
    ];
    console.log(`  ${parts.join(" ")}`);
    if (report.error) console.log(`      error: ${report.error}`);
  }

  console.log(`\nreply attempts: ${details.replies.length}`);
  for (const reply of details.replies) {
    console.log(`  ${reply.status.padEnd(7)} ${reply.recipient} reports=${reply.report_count} sent=${reply.sent_at ?? "-"}`);
    if (reply.error) console.log(`      error: ${reply.error}`);
  }

  console.log(`\nrecent events:`);
  for (const event of details.events.slice(0, 15)) {
    console.log(`  ${String(event.created_at)}  ${String(event.from_status ?? "-")} -> ${String(event.to_status)}  ${String(event.detail ?? "")}`);
  }
}

void run()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    await closePool();
    process.exit(1);
  });
