import "server-only";

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export type CheckpointRecord = {
  key: string;
  sender: string;
  subject: string;
  fileName: string;
  csvHash: string;
  downloadedAt: string;
  propertyCount: number;
  reportFiles: string[];
  replySent: boolean;
  replySentAt?: string | null;
  error?: string | null;
};

type CheckpointStoreData = {
  lastUpdated: string;
  totalProcessed: number;
  processedMessages: Record<string, CheckpointRecord>;
};

const STORE_DIRECTORY = resolve(process.cwd(), "..", ".local");
const CHECKPOINT_FILE = resolve(STORE_DIRECTORY, "gmail-checkpoints.json");

// In-memory cache for fast lookups & serverless warm invocations
let memoryStore: Record<string, CheckpointRecord> = {};

export function computeCheckpointKey(
  sender: string,
  subject: string,
  fileName: string,
  csvContent: string
): string {
  const contentHash = createHash("sha256")
    .update(csvContent.trim())
    .digest("hex")
    .slice(0, 16);
  const rawKey = `${sender.toLowerCase().trim()}|${subject.trim()}|${fileName.trim()}|${contentHash}`;
  return createHash("sha256").update(rawKey).digest("hex").slice(0, 24);
}

async function loadStore(): Promise<Record<string, CheckpointRecord>> {
  try {
    const raw = await readFile(CHECKPOINT_FILE, "utf8");
    const parsed = JSON.parse(raw) as CheckpointStoreData;
    memoryStore = { ...memoryStore, ...(parsed.processedMessages || {}) };
    return memoryStore;
  } catch {
    return memoryStore;
  }
}

async function saveStore(): Promise<void> {
  try {
    await mkdir(STORE_DIRECTORY, { recursive: true });
    const payload: CheckpointStoreData = {
      lastUpdated: new Date().toISOString(),
      totalProcessed: Object.keys(memoryStore).length,
      processedMessages: memoryStore,
    };
    await writeFile(CHECKPOINT_FILE, JSON.stringify(payload, null, 2), { mode: 0o600 });
  } catch {
    // In serverless read-only environments, in-memory cache persists for invocation duration
  }
}

export async function isMessageCompleted(key: string): Promise<boolean> {
  const store = await loadStore();
  const rec = store[key];
  return Boolean(rec?.replySent);
}

export async function registerInboundCheckpoint(
  key: string,
  sender: string,
  subject: string,
  fileName: string,
  csvContent: string
): Promise<CheckpointRecord> {
  const store = await loadStore();
  if (!store[key]) {
    store[key] = {
      key,
      sender,
      subject,
      fileName,
      csvHash: createHash("sha256").update(csvContent).digest("hex"),
      downloadedAt: new Date().toISOString(),
      propertyCount: 0,
      reportFiles: [],
      replySent: false,
    };
    memoryStore = store;
    await saveStore();
  }
  return store[key];
}

export async function updateCheckpointReports(
  key: string,
  propertyCount: number,
  reportFiles: string[]
): Promise<void> {
  const store = await loadStore();
  if (store[key]) {
    store[key].propertyCount = propertyCount;
    store[key].reportFiles = reportFiles;
    memoryStore = store;
    await saveStore();
  }
}

export async function markCheckpointSent(key: string): Promise<void> {
  const store = await loadStore();
  if (store[key]) {
    store[key].replySent = true;
    store[key].replySentAt = new Date().toISOString();
    memoryStore = store;
    await saveStore();
  }
}

export async function markCheckpointError(key: string, error: string): Promise<void> {
  const store = await loadStore();
  if (store[key]) {
    store[key].error = error;
    memoryStore = store;
    await saveStore();
  }
}
