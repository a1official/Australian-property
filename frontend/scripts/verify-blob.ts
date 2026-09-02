#!/usr/bin/env tsx
/**
 * Verifies the private Blob store: upload, non-guessable job-scoped paths,
 * read-back at reply time, and that private blobs are not publicly readable.
 *
 *   pnpm tsx scripts/verify-blob.ts
 */

import { del, head } from "@vercel/blob";
import { randomBytes } from "node:crypto";

import { createJobBlobSecret, downloadBlobText, uploadCsvBlob, uploadReportBlob } from "../lib/blob-storage";

const RUN = randomBytes(4).toString("hex");
const jobId = `job-blobverify-${RUN}`;
const results: Array<{ name: string; pass: boolean; detail: string }> = [];
const created: string[] = [];

function check(name: string, pass: boolean, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function token(): string {
  return process.env.BLOB_READ_WRITE_TOKEN as string;
}

async function run(): Promise<void> {
  const secret = createJobBlobSecret();
  const csv = "address\n1 Blob Street SYDNEY NSW 2000\n";
  const html = "<!doctype html><html><body>verification report</body></html>";

  const csvBlob = await uploadCsvBlob({ jobId, secret, filename: "verify.csv", content: csv });
  created.push(csvBlob.pathname);
  check("source CSV uploads to the private store", Boolean(csvBlob.pathname), csvBlob.pathname);

  check(
    "CSV path is job-scoped and includes a random segment",
    csvBlob.pathname.includes(jobId) && csvBlob.pathname.includes(secret) && secret.length >= 24,
    `secretLen=${secret.length}`,
  );

  const reportBlob = await uploadReportBlob({ jobId, secret, filename: "parcel-atlas-1.html", html });
  created.push(reportBlob.pathname);
  check("report uploads immediately after generation", Boolean(reportBlob.pathname), reportBlob.pathname);

  // Reply-time read-back: only completed reports are downloaded.
  const readBack = await downloadBlobText(reportBlob.pathname);
  check("report reads back byte-identical for the reply", readBack === html, `${readBack.length} chars`);

  const csvReadBack = await downloadBlobText(csvBlob.pathname);
  check("source CSV reads back byte-identical", csvReadBack === csv);

  const meta = await head(reportBlob.pathname, { token: token() });
  check("stored report is not public", (meta as { access?: string }).access !== "public", `access=${(meta as { access?: string }).access ?? "private"}`);

  // A private blob URL must not be readable without credentials.
  const anonymous = await fetch(reportBlob.url, { redirect: "follow" }).catch(() => null);
  check(
    "private blob URL is not anonymously readable",
    !anonymous || !anonymous.ok || !(await anonymous.text()).includes("verification report"),
    anonymous ? `status=${anonymous.status}` : "request blocked",
  );

  // Overwrite-on-retry must not create a second object for the same report.
  const rerun = await uploadReportBlob({ jobId, secret, filename: "parcel-atlas-1.html", html });
  check("re-uploading the same report is stable (no duplicate path)", rerun.pathname === reportBlob.pathname, rerun.pathname);
}

void run()
  .then(async () => {
    for (const pathname of created) {
      await del(pathname, { token: token() }).catch(() => undefined);
    }
    const failed = results.filter((result) => !result.pass);
    console.log(`\n${results.length - failed.length}/${results.length} blob checks passed.`);
    process.exit(failed.length ? 1 : 0);
  })
  .catch(async (error: unknown) => {
    console.error("blob verification error:", error instanceof Error ? error.message : String(error));
    for (const pathname of created) {
      await del(pathname, { token: token() }).catch(() => undefined);
    }
    process.exit(1);
  });
