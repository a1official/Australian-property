/**
 * Reports the structure and visible text of a generated PDF.
 *
 * Reads the raw file rather than re-running generation, so it verifies the
 * artefact that was actually produced. Inflates FlateDecode content streams to
 * recover the drawn text.
 */

import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

const path = process.argv[2];
if (!path) {
  console.error("usage: node inspect-pdf.mjs <file.pdf>");
  process.exit(1);
}

const bytes = readFileSync(path);
const latin = bytes.toString("latin1");

console.log(`file:        ${path}`);
console.log(`bytes:       ${bytes.length}`);
console.log(`header:      ${bytes.subarray(0, 8).toString("ascii").trim()}`);
console.log(`pages:       ${(latin.match(/\/Type\s*\/Page[^s]/g) ?? []).length}`);
console.log(`images:      ${(latin.match(/\/Subtype\s*\/Image/g) ?? []).length}`);
console.log(`fonts:       ${[...new Set((latin.match(/\/BaseFont\s*\/([A-Za-z-]+)/g) ?? []).map((f) => f.split("/").pop()))].join(", ")}`);

// Recover text by inflating every compressed stream and pulling PDF show-text
// operators. Text is emitted in draw order, which mirrors the visual layout.
const lines = [];
const streamPattern = /stream\r?\n/g;
let match;
while ((match = streamPattern.exec(latin)) !== null) {
  const start = match.index + match[0].length;
  const end = latin.indexOf("endstream", start);
  if (end < 0) continue;
  let content;
  try {
    content = inflateSync(bytes.subarray(start, end)).toString("latin1");
  } catch {
    continue; // Not a Flate stream (image data, font file, etc.)
  }
  // pdfkit writes embedded-font text as hex strings inside TJ arrays, e.g.
  // [<4d5552444f4348> 0] TJ, and only sometimes as literal (…) Tj strings.
  // Both forms must be decoded or the extraction silently yields nothing.
  for (const show of content.match(/\[[^\]]*\]\s*TJ|\((?:\\.|[^\\()])*\)\s*Tj/g) ?? []) {
    const parts = [];
    for (const hex of show.match(/<([0-9A-Fa-f\s]+)>/g) ?? []) {
      const digits = hex.replace(/[<>\s]/g, "");
      let decoded = "";
      for (let index = 0; index + 1 < digits.length; index += 2) {
        decoded += String.fromCharCode(parseInt(digits.slice(index, index + 2), 16));
      }
      parts.push(decoded);
    }
    for (const literal of show.match(/\((?:\\.|[^\\()])*\)/g) ?? []) {
      parts.push(
        literal
          .replace(/^\(|\)$/g, "")
          .replace(/\\([()\\])/g, "$1")
          .replace(/\\(\d{3})/g, (_, code) => String.fromCharCode(parseInt(code, 8))),
      );
    }
    const text = parts.join("").replace(/\s+/g, " ").trim();
    if (text) lines.push(text);
  }
}

console.log(`text runs:   ${lines.length}`);
console.log("\n--- visible text, in draw order ---\n");
for (const line of lines) console.log(line);
