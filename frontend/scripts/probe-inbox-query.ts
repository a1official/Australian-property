#!/usr/bin/env tsx
/**
 * Diagnoses why a sent email is not being discovered.
 *
 * Compares the production discovery query against broader ones, so a missing
 * email can be attributed to the query, the attachment, or Gmail ordering.
 * Read-only: lists message metadata only and sends nothing.
 */

import { existsSync, readFileSync } from "node:fs";
import * as nodePath from "node:path";

import { closePool } from "../lib/db";
import { findCsvPart, headerValue, parseAddress } from "../lib/gmail-api";
import { DEFAULT_INBOX_QUERY, openMailbox } from "../lib/gmail-mailbox";
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

const log = createLogger({ script: "probe-inbox-query" }, { minLevel: "error" });

async function run(): Promise<void> {
  const mailbox = await openMailbox({ logger: log });

  const queries: Array<[string, string]> = [
    ["production", DEFAULT_INBOX_QUERY],
    ["any attachment", "has:attachment"],
    ["newest 10, no filter", ""],
    ["csv filename only", "filename:csv"],
    ["last day", "newer_than:1d"],
  ];

  for (const [label, query] of queries) {
    const messages = await mailbox.listCandidateMessages(query, 10);
    console.log(`\n[${label}] query="${query}" -> ${messages.length} message(s)`);

    for (const item of messages.slice(0, 6)) {
      const message = await mailbox.getMessage(item.id);
      const from = parseAddress(headerValue(message.payload, "From"));
      const subject = headerValue(message.payload, "Subject") || "(no subject)";
      const date = headerValue(message.payload, "Date");
      const csv = findCsvPart(message.payload);
      // Report every attachment filename, so a wrong extension is visible.
      const filenames: string[] = [];
      const walk = (part: typeof message.payload) => {
        if (!part) return;
        if (part.filename) filenames.push(part.filename);
        for (const child of part.parts ?? []) walk(child);
      };
      walk(message.payload);

      console.log(`  ${item.id}  ${from.email}`);
      console.log(`     subject:     ${subject.slice(0, 70)}`);
      console.log(`     date:        ${date}`);
      console.log(`     attachments: ${filenames.length ? filenames.join(", ") : "(none)"}`);
      console.log(`     csv part:    ${csv ? `yes (${csv.filename ?? "unnamed"}, ${csv.mimeType ?? "no mime"})` : "NO"}`);
    }
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
