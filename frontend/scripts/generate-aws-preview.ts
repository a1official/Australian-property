/**
 * Safe dry run for the direct Cotality Lambda report path.
 *
 * Resolves one address, generates the PDF entirely from Cotality, and writes it
 * to disk. It creates no Neon job, enqueues nothing, and sends no email.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { generatePropertyPdfDirect, matchAddressDirect } from "../lib/aws-report-pipeline";

async function main() {
  const address = process.argv.slice(2).find((argument) => !argument.startsWith("--")) ?? "1 Macquarie Street Sydney NSW 2000";
  console.log(`address: ${address}`);

  const match = await matchAddressDirect(address);
  console.log(`match: ${match.kind}`);
  if (match.kind !== "exact") throw new Error(match.reason);
  console.log(`propertyId: ${match.propertyId}`);
  console.log(`normalized: ${match.normalizedAddress}`);

  const report = await generatePropertyPdfDirect({ propertyId: match.propertyId, address: match.normalizedAddress });
  const { diagnostics } = report;

  // Scoring must be observable: a zero range would mean the stub is still live.
  console.log(`candidates mapped:  ${diagnostics.candidateCount}`);
  console.log(`candidates in PDF:  ${diagnostics.selectedCount}`);
  console.log(
    `score range:        ${diagnostics.scoreRange ? `${diagnostics.scoreRange.min}-${diagnostics.scoreRange.max}` : "none"}`,
  );
  console.log(
    `market rent:        low=${diagnostics.marketRent.low} high=${diagnostics.marketRent.high} avg=${diagnostics.marketRent.average} from ${diagnostics.marketRent.count} weekly rents`,
  );
  console.log(`emailData:          ${JSON.stringify(report.emailData)}`);

  const directory = resolve(process.cwd(), "..", "output", "pdf");
  await mkdir(directory, { recursive: true });
  const output = resolve(directory, report.filename);
  await writeFile(output, report.content);
  console.log(`pdf bytes:          ${report.content.byteLength}`);
  console.log(`written:            ${output}`);

  if (!diagnostics.scoreRange || diagnostics.scoreRange.max === 0) {
    throw new Error("Candidate scores are all zero; similarity scoring is not being applied.");
  }
}

void main().catch((error: unknown) => {
  console.error(`dry run failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
