#!/usr/bin/env tsx
/**
 * Clears the Gmail password-login rate limit.
 *
 * Run this after fixing the underlying cause (corrected password, completed
 * 2FA, resolved Google security alert). It re-enables automatic login attempts.
 *
 *   pnpm tsx scripts/reset-login-gate.ts
 */

import { checkLoginGate, closePool, getPool, resetLoginGate } from "../lib/db";
import { createLogger } from "../lib/logger";

const log = createLogger({ script: "reset-login-gate" });

async function run(): Promise<void> {
  const { rows } = await getPool().query<{ attempts: number; last_outcome: string | null; cooldown_until: string | null }>(
    "SELECT attempts, last_outcome, cooldown_until FROM gmail_login_attempts WHERE id = 'default' LIMIT 1",
  );
  log.info("gate.before", {
    attempts: rows[0]?.attempts ?? 0,
    lastOutcome: rows[0]?.last_outcome ?? null,
    cooldownUntil: rows[0]?.cooldown_until ?? null,
  });

  await resetLoginGate();
  const gate = await checkLoginGate();
  log.info("gate.after", { allowed: gate.allowed, attempts: gate.attempts });
}

void run()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    log.error("gate.reset_failed", { error: error instanceof Error ? error.message : String(error) });
    await closePool();
    process.exit(1);
  });
