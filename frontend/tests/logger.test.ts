import assert from "node:assert/strict";
import test from "node:test";

import { createLogger, redact } from "../lib/logger";

function capture(minLevel?: "debug" | "info" | "warn" | "error") {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({ service: "worker" }, { minLevel: minLevel ?? "debug", sink: (line) => lines.push(JSON.parse(line)) });
  return { logger, lines };
}

test("emits structured JSON with level, message and bindings", () => {
  const { logger, lines } = capture();
  logger.info("job claimed", { jobId: "job-1" });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, "info");
  assert.equal(lines[0].msg, "job claimed");
  assert.equal(lines[0].service, "worker");
  assert.equal(lines[0].jobId, "job-1");
  assert.match(String(lines[0].ts), /^\d{4}-\d{2}-\d{2}T/);
});

test("child loggers inherit and extend bindings", () => {
  const { logger, lines } = capture();
  logger.child({ jobId: "job-2" }).warn("retrying");
  assert.equal(lines[0].service, "worker");
  assert.equal(lines[0].jobId, "job-2");
});

test("redacts Browserless tokens in URLs", () => {
  assert.equal(
    redact("connecting to wss://production-sfo.browserless.io?token=abc123secret&stealth=true"),
    "connecting to wss://production-sfo.browserless.io?token=***&stealth=true",
  );
});

test("redacts postgres credentials in connection strings", () => {
  assert.equal(
    redact("postgresql://neonuser:sup3rsecret@host.neon.tech/neondb"),
    "postgresql://***:***@host.neon.tech/neondb",
  );
});

test("redacts bearer tokens", () => {
  assert.equal(redact("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload"), "Authorization: Bearer ***");
});

test("redacts secret-shaped field names anywhere in the payload", () => {
  const { logger, lines } = capture();
  logger.info("config", {
    GMAIL_PASSWORD: "hunter2",
    databaseUrl: "postgres://u:p@h/db",
    nested: { clientSecret: "shhh", safe: "keep" },
  });
  assert.equal(lines[0].GMAIL_PASSWORD, "***");
  assert.equal(lines[0].databaseUrl, "***");
  assert.deepEqual(lines[0].nested, { clientSecret: "***", safe: "keep" });
});

test("honours the minimum level", () => {
  const { logger, lines } = capture("warn");
  logger.debug("noise");
  logger.info("noise");
  logger.error("kept");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].msg, "kept");
});
