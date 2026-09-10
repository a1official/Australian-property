#!/usr/bin/env tsx
/** Read-only snapshot of the most recent jobs and their per-property progress. */

import { closePool, getJobDetails, listRecentJobs } from "../lib/db";

async function run(): Promise<void> {
  const limit = Number(process.argv[2] || 4);
  const jobs = await listRecentJobs(limit);

  console.log(`\nmost recent ${jobs.length} job(s)\n`);
  for (const job of jobs) {
    console.log(
      `${String(job.id)}  ${String(job.status).padEnd(14)} reports=${job.report_count}/${job.row_count} review=${job.review_count} ${String(job.created_at)}`,
    );
    if (job.error) console.log(`    error: ${String(job.error).slice(0, 160)}`);
  }

  const newest = jobs[0];
  if (!newest) return;

  const details = await getJobDetails(String(newest.id));
  if (!details) return;

  console.log(`\n--- ${newest.id} property rows ---`);
  const counts: Record<string, number> = {};
  for (const report of details.reports) {
    counts[report.status] = (counts[report.status] ?? 0) + 1;
    console.log(`  row ${String(report.row_number).padEnd(3)} ${report.status.padEnd(13)} ${report.original_address}`);
    if (report.error) console.log(`      ${report.error.slice(0, 140)}`);
  }
  console.log(`\n  status totals: ${JSON.stringify(counts)}`);

  console.log(`\n--- reply attempts (${details.replies.length}) ---`);
  for (const reply of details.replies) {
    console.log(`  ${reply.status.padEnd(7)} ${reply.recipient} reports=${reply.report_count} sent=${reply.sent_at ?? "-"}`);
    if (reply.error) console.log(`      ${reply.error.slice(0, 140)}`);
  }

  console.log(`\n--- recent events ---`);
  for (const event of details.events.slice(0, 10)) {
    console.log(`  ${String(event.created_at)}  ${String(event.from_status ?? "-")} -> ${String(event.to_status)}  ${String(event.detail ?? "").slice(0, 90)}`);
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
