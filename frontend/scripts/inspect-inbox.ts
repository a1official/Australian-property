#!/usr/bin/env tsx
/**
 * Read-only inbox inspection.
 *
 * Lists candidate CSV emails and reports what the pipeline would do with each,
 * including whether it has already been processed. Sends nothing, creates no
 * job, uploads nothing, and enqueues nothing.
 */

import { existsSync, readFileSync } from "node:fs";
import * as nodePath from "node:path";

import { closePool, findJobByIdempotencyKey } from "../lib/db";
import { buildIdempotencyKey, validateCsvAttachment } from "../lib/csv-intake";
import { discoverCsvAttachments, openMailbox } from "../lib/gmail-mailbox";
import { createLogger } from "../lib/logger";

for (const candidate of [
  nodePath.resolve(process.cwd(), "..", ".env"),
  nodePath.resolve(process.cwd(), ".env"),
  nodePath.resolve(process.cwd(), ".env.local"),
]) {
  if (!existsSync(candidate)) continue;
  for (const line of readFileSync(candidate, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
}

const log = createLogger({ script: "inspect-inbox" }, { minLevel: "warn" });

async function run(): Promise<void> {
  const mailbox = await openMailbox({ logger: log });
  const found = await discoverCsvAttachments(mailbox, { maxMessages: 5, logger: log });

  console.log(`\nCandidate CSV emails: ${found.length}\n`);

  for (const item of found) {
    console.log(`from:      ${item.sender}`);
    console.log(`subject:   ${item.subject}`);
    console.log(`file:      ${item.filename} (${item.mimeType}, ${item.csvContent.length} chars)`);
    console.log(`messageId: ${item.messageId}`);
    console.log(`threadId:  ${item.threadId}`);

    try {
      const validated = validateCsvAttachment({
        fileName: item.filename,
        content: item.csvContent,
        mimeType: item.mimeType,
      });
      console.log(`csv:       valid, ${validated.addresses.length} address row(s)`);
      for (const address of validated.addresses) {
        console.log(`             row ${address.rowNumber}: ${address.address}`);
      }

      const key = buildIdempotencyKey({
        sender: item.sender,
        threadId: item.threadId,
        messageId: item.messageId,
        fileName: validated.fileName,
        csvContent: item.csvContent,
      });
      const existing = await findJobByIdempotencyKey(key);
      console.log(
        existing
          ? `status:    ALREADY PROCESSED as ${existing.id} (${existing.status}) — a run would skip it`
          : `status:    NEW — a run would create a job and reply to ${item.sender}`,
      );
    } catch (error) {
      console.log(`csv:       REJECTED — ${error instanceof Error ? error.message : String(error)}`);
    }
    console.log("");
  }

  // First lines of the newest CSV, so column shape can be eyeballed.
  const newest = found[0];
  if (newest) {
    console.log("--- newest CSV, first 4 lines ---");
    for (const line of newest.csvContent.split(/\r?\n/).slice(0, 4)) console.log(`  ${line}`);
  }
}

void run()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error(`inspection failed: ${error instanceof Error ? error.message : String(error)}`);
    await closePool();
    process.exit(1);
  });
