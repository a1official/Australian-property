/**
 * CSV intake validation shared by the Vercel enqueue API and the scheduled worker.
 *
 * Pure functions only: no filesystem, network, or Next.js imports, so this can
 * be unit tested directly and reused from a plain Node worker process.
 */

import { createHash } from "node:crypto";

export const ADDRESS_HEADERS = ["address", "property address", "full address"];
export const MAX_CSV_BYTES = 1_000_000;
export const MAX_ADDRESS_ROWS = 10;
export const MAX_ADDRESS_LENGTH = 300;
export const ALLOWED_CSV_MIME_TYPES = ["text/csv", "application/csv", "text/plain", "application/vnd.ms-excel"];

/** Permanent validation problems must never be retried by the worker. */
export class CsvValidationError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = "CsvValidationError";
  }
}

export function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character === '"') {
      if (quoted && content[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && content[index + 1] === "\n") index += 1;
      row.push(cell);
      cell = "";
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
    } else {
      cell += character;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

export function csvContentHash(content: string): string {
  return createHash("sha256").update(content.trim(), "utf8").digest("hex");
}

/**
 * Idempotency is keyed on Gmail identity plus CSV content. Re-sending the same
 * file in the same thread resolves to the same job; a genuinely new CSV does not.
 */
export function buildIdempotencyKey(input: {
  sender: string;
  threadId?: string | null;
  messageId?: string | null;
  fileName: string;
  csvContent: string;
}): string {
  const identity = input.threadId?.trim() || input.messageId?.trim() || `sender:${input.sender.trim().toLowerCase()}`;
  const raw = [identity, input.fileName.trim().toLowerCase(), csvContentHash(input.csvContent)].join("|");
  return createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 40);
}

/**
 * Validates a sender against an explicit allow-list, unless the operator has
 * deliberately enabled public CSV intake. Even public intake requires a real
 * email address; an empty/malformed Gmail DOM value is never accepted.
 */
export function isAllowedSender(sender: string, allowedSenders: string[], allowAnySender = false): boolean {
  const normalized = sender.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return false;
  if (allowAnySender) return true;
  if (!allowedSenders.length) return false;
  return allowedSenders.some((allowed) => allowed.trim().toLowerCase() === normalized);
}

export type ValidatedCsv = {
  fileName: string;
  addresses: Array<{ rowNumber: number; address: string }>;
  contentHash: string;
  byteLength: number;
};

export function validateCsvAttachment(input: {
  fileName: string;
  content: string;
  mimeType?: string | null;
}): ValidatedCsv {
  const fileName = input.fileName.trim();
  if (!/^[\w][\w .()-]{0,120}\.csv$/i.test(fileName)) {
    throw new CsvValidationError(`Attachment name is not an accepted CSV file name: ${fileName || "(empty)"}`);
  }

  if (input.mimeType) {
    const mime = input.mimeType.split(";")[0].trim().toLowerCase();
    if (!ALLOWED_CSV_MIME_TYPES.includes(mime)) {
      throw new CsvValidationError(`Attachment MIME type ${mime} is not an accepted CSV type.`);
    }
  }

  const content = input.content.replace(/^\uFEFF/, "");
  const byteLength = Buffer.byteLength(content, "utf8");
  if (!byteLength) throw new CsvValidationError("CSV attachment is empty.");
  if (byteLength > MAX_CSV_BYTES) {
    throw new CsvValidationError(`CSV attachment is ${byteLength} bytes; the limit is ${MAX_CSV_BYTES} bytes.`);
  }

  const rows = parseCsv(content);
  if (!rows.length) throw new CsvValidationError("CSV attachment has no readable rows.");

  const headers = (rows[0] ?? []).map((header) => header.trim().toLowerCase());
  const addressColumn = headers.findIndex((header) => ADDRESS_HEADERS.includes(header));
  if (addressColumn < 0) {
    throw new CsvValidationError(
      `CSV requires one of these columns: ${ADDRESS_HEADERS.join(", ")}. Found: ${headers.join(", ") || "(no header row)"}`,
    );
  }

  const addresses: Array<{ rowNumber: number; address: string }> = [];
  const seen = new Set<string>();
  rows.slice(1).forEach((row, index) => {
    const address = (row[addressColumn] ?? "").trim();
    if (!address) return;
    if (address.length > MAX_ADDRESS_LENGTH) {
      throw new CsvValidationError(`Row ${index + 2} address exceeds ${MAX_ADDRESS_LENGTH} characters.`);
    }
    const key = address.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) return;
    seen.add(key);
    addresses.push({ rowNumber: index + 2, address });
  });

  if (!addresses.length) throw new CsvValidationError("CSV does not contain any property addresses.");
  if (addresses.length > MAX_ADDRESS_ROWS) {
    throw new CsvValidationError(
      `CSV contains ${addresses.length} addresses; the maximum supported per email is ${MAX_ADDRESS_ROWS}.`,
    );
  }

  return { fileName, addresses, contentHash: csvContentHash(content), byteLength };
}
