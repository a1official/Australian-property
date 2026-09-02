#!/usr/bin/env tsx
/** Shows the current Gmail login rate-limit state. */

import { checkLoginGate, closePool, getPool } from "../lib/db";

async function run(): Promise<void> {
  const { rows } = await getPool().query<{
    attempts: number;
    last_attempt_at: string | null;
    last_outcome: string | null;
    cooldown_until: string | null;
  }>("SELECT attempts, last_attempt_at, last_outcome, cooldown_until FROM gmail_login_attempts WHERE id = 'default'");

  const record = rows[0];
  console.log("attempts:       ", record?.attempts ?? 0);
  console.log("last attempt:   ", record?.last_attempt_at ?? "never");
  console.log("cooldown until: ", record?.cooldown_until ?? "none");
  console.log("last outcome:   ", (record?.last_outcome ?? "none").slice(0, 120));

  const gate = await checkLoginGate();
  console.log("\nnext login allowed:", gate.allowed);
  if (!gate.allowed) console.log("blocked because:  ", (gate as { reason: string }).reason.slice(0, 160));
}

void run()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error("failed:", error instanceof Error ? error.message : String(error));
    await closePool();
    process.exit(1);
  });
