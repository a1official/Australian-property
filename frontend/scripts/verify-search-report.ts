import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generatePropertyPdf, matchAddress } from "../lib/report-pipeline";

async function main() {
  const address = process.argv[2] || "14 Charles Street Baulkham Hills NSW 2153";
  const options = { baseUrl: "http://localhost:3004", timeoutMs: 120000 };
  const match = await matchAddress(address, options);
  if (match.kind !== "exact") throw new Error("Address requires review: " + match.kind);
  const result = await generatePropertyPdf({ propertyId: match.propertyId, address: match.normalizedAddress }, options);
  if (result.emailData.marketRentAverage === null) throw new Error("No usable rental evidence returned.");
  const directory = resolve("../output/search-report-check");
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, result.filename);
  await writeFile(path, result.content);
  console.log(JSON.stringify({ path, bytes: result.content.length, propertyId: match.propertyId, emailData: result.emailData }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
