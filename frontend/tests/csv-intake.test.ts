import assert from "node:assert/strict";
import test from "node:test";

import {
  CsvValidationError,
  MAX_ADDRESS_ROWS,
  buildIdempotencyKey,
  csvContentHash,
  isAllowedSender,
  parseCsv,
  validateCsvAttachment,
} from "../lib/csv-intake";

const validCsv = "address,notes\n1 Test Street SYDNEY NSW 2000,first\n2 Sample Road PARRAMATTA NSW 2150,second\n";

test("parseCsv handles quoted commas, escaped quotes and CRLF", () => {
  const rows = parseCsv('address,note\r\n"1 Test St, Unit 4","He said ""hi"""\r\n');
  assert.deepEqual(rows, [
    ["address", "note"],
    ["1 Test St, Unit 4", 'He said "hi"'],
  ]);
});

test("validateCsvAttachment extracts addresses with 1-based row numbers", () => {
  const result = validateCsvAttachment({ fileName: "batch.csv", content: validCsv, mimeType: "text/csv" });
  assert.equal(result.addresses.length, 2);
  assert.deepEqual(result.addresses[0], { rowNumber: 2, address: "1 Test Street SYDNEY NSW 2000" });
  assert.deepEqual(result.addresses[1], { rowNumber: 3, address: "2 Sample Road PARRAMATTA NSW 2150" });
});

test("validateCsvAttachment accepts alternate address headers and a BOM", () => {
  const result = validateCsvAttachment({
    fileName: "batch.csv",
    content: "\uFEFFFull Address\n1 Test Street SYDNEY NSW 2000\n",
  });
  assert.equal(result.addresses.length, 1);
});

test("validateCsvAttachment de-duplicates repeated addresses", () => {
  const result = validateCsvAttachment({
    fileName: "batch.csv",
    content: "address\n1 Test Street SYDNEY\n1  test   street  sydney\n",
  });
  assert.equal(result.addresses.length, 1);
});

test("validateCsvAttachment rejects a missing address column", () => {
  assert.throws(
    () => validateCsvAttachment({ fileName: "batch.csv", content: "suburb,rent\nSydney,600\n" }),
    CsvValidationError,
  );
});

test("validateCsvAttachment rejects a disallowed MIME type", () => {
  assert.throws(
    () => validateCsvAttachment({ fileName: "batch.csv", content: validCsv, mimeType: "application/zip" }),
    CsvValidationError,
  );
});

test("validateCsvAttachment rejects a non-csv file name", () => {
  assert.throws(
    () => validateCsvAttachment({ fileName: "payload.html", content: validCsv }),
    CsvValidationError,
  );
});

test("validateCsvAttachment enforces the row limit", () => {
  const rows = Array.from({ length: MAX_ADDRESS_ROWS + 1 }, (_, index) => `${index + 1} Test Street SYDNEY NSW 2000`);
  assert.throws(
    () => validateCsvAttachment({ fileName: "batch.csv", content: `address\n${rows.join("\n")}\n` }),
    CsvValidationError,
  );
});

test("validateCsvAttachment rejects an oversized payload", () => {
  const big = `address\n${"1 Test Street SYDNEY NSW 2000\n".repeat(40_000)}`;
  assert.throws(() => validateCsvAttachment({ fileName: "batch.csv", content: big }), CsvValidationError);
});

test("validation errors are marked permanent so retries stop", () => {
  const error = new CsvValidationError("bad csv");
  assert.equal(error.permanent, true);
});

test("idempotency key is stable for identical thread and content", () => {
  const input = { sender: "Agent@Example.com", threadId: "thread-1", fileName: "Batch.csv", csvContent: validCsv };
  assert.equal(buildIdempotencyKey(input), buildIdempotencyKey({ ...input, sender: "agent@example.com" }));
});

test("idempotency key changes when CSV content changes", () => {
  const base = { sender: "agent@example.com", threadId: "thread-1", fileName: "batch.csv" };
  assert.notEqual(
    buildIdempotencyKey({ ...base, csvContent: validCsv }),
    buildIdempotencyKey({ ...base, csvContent: validCsv + "3 Another Street SYDNEY NSW 2000\n" }),
  );
});

test("idempotency key falls back to messageId then sender", () => {
  const withMessage = buildIdempotencyKey({ sender: "a@b.com", messageId: "msg-9", fileName: "b.csv", csvContent: validCsv });
  const senderOnly = buildIdempotencyKey({ sender: "a@b.com", fileName: "b.csv", csvContent: validCsv });
  assert.notEqual(withMessage, senderOnly);
  assert.match(withMessage, /^[0-9a-f]{40}$/);
});

test("content hash ignores surrounding whitespace only", () => {
  assert.equal(csvContentHash(validCsv), csvContentHash(`\n${validCsv}  `));
  assert.notEqual(csvContentHash(validCsv), csvContentHash(validCsv.replace("first", "second")));
});

test("sender allow-list is case insensitive and closed by default", () => {
  assert.equal(isAllowedSender("Agent@Example.com", ["agent@example.com"]), true);
  assert.equal(isAllowedSender("other@example.com", ["agent@example.com"]), false);
  assert.equal(isAllowedSender("agent@example.com", []), false);
  assert.equal(isAllowedSender("", ["agent@example.com"]), false);
});
