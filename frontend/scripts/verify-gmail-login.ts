#!/usr/bin/env tsx
/**
 * Exercises the full Gmail leg through Browserless exactly as the worker does:
 * reuse the stored session, else log in with the bot credentials, save the new
 * session, then confirm the inbox search and attachment selectors resolve.
 *
 * The login rate limit applies, so a repeated failure will not hammer Google.
 *
 *   pnpm tsx scripts/verify-gmail-login.ts
 */

import { checkLoginGate, closePool } from "../lib/db";
import { discoverCsvEmails, openGmailSession } from "../lib/gmail-worker";
import { createLogger, redact } from "../lib/logger";

const log = createLogger({ script: "verify-gmail-login" });

async function run(): Promise<void> {
  const gate = await checkLoginGate();
  log.info("gate.state", { allowed: gate.allowed, attempts: gate.attempts });
  if (!gate.allowed) {
    log.error("gate.blocked", { reason: (gate as { reason: string }).reason });
    return;
  }

  const session = await openGmailSession({
    wsEndpoint: process.env.BROWSERLESS_WS_ENDPOINT,
    apiKey: process.env.BROWSERLESS_API_KEY,
    username: process.env.GMAIL_USERNAME || "",
    password: process.env.GMAIL_PASSWORD || "",
    logger: log,
  });

  try {
    log.info("session.open", { note: "Authenticated through Browserless." });

    // Discovery is read-only: it opens threads and reads attachments, and does
    // not send anything.
    const found = await discoverCsvEmails(session.context, { maxEmails: 3, logger: log });
    log.info("discovery.result", {
      csvEmailsFound: found.length,
      details: found.map((item) => ({
        sender: item.sender,
        fileName: item.fileName,
        mimeType: item.mimeType,
        bytes: item.csvContent.length,
        hasThreadId: Boolean(item.threadId),
        firstLine: item.csvContent.split(/\r?\n/)[0]?.slice(0, 60),
      })),
    });
    log.info("verdict", {
      browserless: "ok",
      gmailAuth: "ok",
      inboxParsing: found.length ? "ok" : "no matching CSV emails to parse",
    });
  } finally {
    await session.close();
  }
}

void run()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    log.error("verify.failed", {
      error: redact(error instanceof Error ? error.message : String(error)),
      name: error instanceof Error ? error.name : "unknown",
    });
    await closePool();
    process.exit(1);
  });
