import "server-only";

import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];
const STORE_DIRECTORY = resolve(process.cwd(), "..", ".local");
const STORE_FILE = resolve(STORE_DIRECTORY, "gmail-connection.json");

type StoredConnection = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  email: string;
  connectedAt: string;
  localActionToken: string;
};

type GmailMessage = {
  id: string;
  payload?: GmailPart;
};

type GmailPart = {
  filename?: string;
  mimeType?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { attachmentId?: string; data?: string; size?: number };
  parts?: GmailPart[];
};

function parseEnvironment(content: string) {
  return Object.fromEntries(content.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^([^#][^=]*)=(.*)$/);
    return match ? [[match[1].trim(), match[2].trim()]] : [];
  }));
}

async function settings() {
  let fallback: Record<string, string> = {};
  try { fallback = parseEnvironment(await readFile(resolve(process.cwd(), "..", ".env"), "utf8")); } catch { /* local setup may not exist yet */ }
  const username = process.env.GMAIL_USERNAME || fallback.GMAIL_USERNAME;
  const password = process.env.GMAIL_PASSWORD || fallback.GMAIL_PASSWORD;
  const clientId = process.env.GMAIL_CLIENT_ID || fallback.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET || fallback.GMAIL_CLIENT_SECRET;
  const redirectUri = process.env.GMAIL_REDIRECT_URI || fallback.GMAIL_REDIRECT_URI || "http://localhost:3004/api/gmail/callback";
  const allowedSenders = (process.env.GMAIL_ALLOWED_SENDERS || fallback.GMAIL_ALLOWED_SENDERS || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  return { username, password, clientId, clientSecret, redirectUri, allowedSenders };
}

async function readConnection(): Promise<StoredConnection | null> {
  try { return JSON.parse(await readFile(STORE_FILE, "utf8")) as StoredConnection; } catch { return null; }
}

async function saveConnection(connection: StoredConnection) {
  await mkdir(STORE_DIRECTORY, { recursive: true });
  await writeFile(STORE_FILE, JSON.stringify(connection, null, 2), { mode: 0o600 });
}

function base64UrlToText(value: string) {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function toBase64Url(value: string) {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function header(part: GmailPart | undefined, name: string) {
  return part?.headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

function emailAddress(value: string) {
  return (value.match(/<([^>]+)>/)?.[1] || value).trim().toLowerCase();
}

function findCsvPart(part: GmailPart | undefined): GmailPart | null {
  if (!part) return null;
  if (part.filename?.toLowerCase().endsWith(".csv") || part.mimeType === "text/csv") return part;
  for (const child of part.parts || []) {
    const found = findCsvPart(child);
    if (found) return found;
  }
  return null;
}

async function accessToken() {
  const connection = await readConnection();
  const config = await settings();
  if (!connection) throw new Error("Gmail is not connected.");
  if (connection.expiresAt > Date.now() + 60_000) return connection.accessToken;
  if (!config.clientId || !config.clientSecret) throw new Error("Gmail OAuth client credentials are not configured.");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, refresh_token: connection.refreshToken, grant_type: "refresh_token" }),
    cache: "no-store",
  });
  const payload = await response.json() as { access_token?: string; expires_in?: number; error_description?: string };
  if (!response.ok || !payload.access_token) throw new Error(payload.error_description || "Gmail token refresh failed.");
  const refreshed = { ...connection, accessToken: payload.access_token, expiresAt: Date.now() + (payload.expires_in || 3_600) * 1_000 };
  await saveConnection(refreshed);
  return refreshed.accessToken;
}

async function gmail(path: string, init: RequestInit = {}) {
  const response = await fetch(`${GMAIL_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken()}`, Accept: "application/json", ...init.headers },
    cache: "no-store",
  });
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  if (!response.ok) throw new Error(body?.error?.message || `Gmail returned ${response.status}.`);
  return body;
}

export async function gmailStatus() {
  const config = await settings();
  const connection = await readConnection();
  return {
    configured: Boolean(config.clientId && config.clientSecret),
    connected: Boolean(connection),
    email: connection?.email || null,
    allowedSendersConfigured: config.allowedSenders.length > 0,
  };
}

export async function gmailAuthorisationUrl(state: string) {
  const config = await settings();
  if (!config.clientId || !config.clientSecret) throw new Error("Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET before connecting Gmail.");
  const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: "code", access_type: "offline", prompt: "consent", scope: SCOPES.join(" "), state });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function connectGmail(code: string) {
  const config = await settings();
  if (!config.clientId || !config.clientSecret) throw new Error("Gmail OAuth client credentials are not configured.");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri, grant_type: "authorization_code" }),
    cache: "no-store",
  });
  const token = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string };
  if (!response.ok || !token.access_token || !token.refresh_token) throw new Error(token.error_description || "Gmail OAuth connection failed.");
  const profile = await fetch(`${GMAIL_API}/profile`, { headers: { Authorization: `Bearer ${token.access_token}` } }).then((item) => item.json()) as { emailAddress?: string };
  if (!profile.emailAddress) throw new Error("Gmail did not return the connected mailbox address.");
  const connection = { accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: Date.now() + (token.expires_in || 3_600) * 1_000, email: profile.emailAddress, connectedAt: new Date().toISOString(), localActionToken: randomBytes(32).toString("base64url") };
  await saveConnection(connection);
  return { email: profile.emailAddress, localActionToken: connection.localActionToken };
}

export async function authoriseLocalGmailAction(token: string | undefined) {
  const connection = await readConnection();
  if (!connection?.localActionToken || !token) throw new Error("Connect Gmail again before using inbox automation.");
  const expected = Buffer.from(connection.localActionToken);
  const received = Buffer.from(token);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw new Error("Gmail local action authorisation is invalid.");
}

export async function importIncomingCsv() {
  const config = await settings();
  if (!config.allowedSenders.length) throw new Error("Set GMAIL_ALLOWED_SENDERS to the addresses permitted to trigger report jobs.");
  const list = await gmail("/messages?maxResults=5&q=" + encodeURIComponent("is:unread has:attachment filename:csv")) as { messages?: Array<{ id: string }> };
  const imports: Array<{ messageId: string; sender: string; subject: string; fileName: string; csv: string }> = [];
  for (const item of list.messages || []) {
    const message = await gmail(`/messages/${item.id}?format=full`) as GmailMessage;
    const sender = emailAddress(header(message.payload, "From"));
    if (!config.allowedSenders.includes(sender)) continue;
    const part = findCsvPart(message.payload);
    if (!part?.body || (part.body.size || 0) > 1_000_000) continue;
    const encoded = part.body.data || (part.body.attachmentId ? String((await gmail(`/messages/${item.id}/attachments/${part.body.attachmentId}`) as { data?: string }).data || "") : "");
    if (!encoded || encoded.length > 1_400_000) continue;
    imports.push({ messageId: item.id, sender, subject: header(message.payload, "Subject") || "CSV rent review request", fileName: part.filename || "property-batch.csv", csv: base64UrlToText(encoded) });
  }
  return imports;
}

export async function sendReports(input: { recipient: string; subject: string; reports: Array<{ fileName: string; html: string }>; sourceMessageId?: string }) {
  const config = await settings();
  const recipient = input.recipient.trim().toLowerCase();
  if (!config.allowedSenders.includes(recipient)) throw new Error("Reports can only be sent to an approved CSV sender.");
  if (!input.reports.length || input.reports.length > 10) throw new Error("Attach between one and ten completed reports.");
  if (/\r|\n/.test(input.subject)) throw new Error("Email subject contains invalid characters.");
  if (input.reports.some((report) => !/^[a-z0-9][a-z0-9._-]{0,120}\.html$/i.test(report.fileName))) throw new Error("A report attachment name is invalid.");
  const boundary = `parcel-atlas-${crypto.randomUUID()}`;
  const attachmentParts = input.reports.map((report) => [`--${boundary}`, `Content-Type: text/html; name=\"${report.fileName}\"`, "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; filename=\"${report.fileName}\"`, "", Buffer.from(report.html, "utf8").toString("base64")].join("\r\n"));
  const raw = [
    `To: ${recipient}`,
    `Subject: ${input.subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary=\"${boundary}\"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    `Your Parcel Atlas rent-review reports are attached. ${input.reports.length} report${input.reports.length === 1 ? " was" : "s were"} generated from your CSV.`,
    ...attachmentParts,
    `--${boundary}--`,
  ].join("\r\n");
  await gmail("/messages/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ raw: toBase64Url(raw) }) });
  if (input.sourceMessageId) await gmail(`/messages/${input.sourceMessageId}/modify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ removeLabelIds: ["UNREAD"] }) });
}
