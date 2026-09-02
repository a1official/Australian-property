#!/usr/bin/env tsx
/**
 * One-time migration of the locally saved Gmail session into Neon.
 *
 * The worker treats Neon as the source of truth for browser session state, so a
 * fresh Render instance can resume without any local profile. This script reads
 * .local/gmail-session.json once and stores it. Nothing is printed from the file.
 *
 *   pnpm tsx scripts/seed-gmail-session.ts
 */

import { existsSync, readFileSync } from "node:fs";
import * as nodePath from "node:path";

import { closePool, loadGmailSession, saveGmailSession } from "../lib/db";
import { createLogger } from "../lib/logger";

const log = createLogger({ script: "seed-gmail-session" });

async function run(): Promise<void> {
  const sessionPath = nodePath.resolve(process.cwd(), "..", ".local", "gmail-session.json");
  if (!existsSync(sessionPath)) {
    throw new Error("No local Gmail session found at .local/gmail-session.json. Run `pnpm gmail:auth` first.");
  }

  const parsed = JSON.parse(readFileSync(sessionPath, "utf8")) as { cookies?: unknown[]; origins?: unknown[] };
  const cookieCount = Array.isArray(parsed.cookies) ? parsed.cookies.length : 0;
  if (!cookieCount) {
    throw new Error("The saved session contains no cookies; re-run `pnpm gmail:auth`.");
  }

  await saveGmailSession(parsed);
  const stored = await loadGmailSession();
  // Report counts only. Cookie values are never logged.
  log.info("session.seeded", {
    cookieCount,
    originCount: Array.isArray(parsed.origins) ? parsed.origins.length : 0,
    verified: Boolean(stored),
  });
}

void run()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    log.error("session.seed_failed", { error: error instanceof Error ? error.message : String(error) });
    await closePool();
    process.exit(1);
  });
