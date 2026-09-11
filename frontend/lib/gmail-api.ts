/**
 * Gmail API operations for the durable worker.
 *
 * Replaces the Browserless/Playwright inbox and reply adapter. No browser, no
 * cookies, no password. `fetchImpl` is injectable so every path is testable
 * without touching a real mailbox.
 */

import { GMAIL_API_BASE, NeedsReauthorizationError, type FetchLike } from "./gmail-oauth";

const MAX_ATTACHMENT_BYTES = 1_000_000;

export type GmailHeader = { name?: string; value?: string };

export type GmailPart = {
  partId?: string;
  filename?: string;
  mimeType?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; data?: string; size?: number };
  parts?: GmailPart[];
};

export type GmailMessage = {
  id: string;
  threadId: string;
  labelIds?: string[];
  payload?: GmailPart;
};

export type DiscoveredAttachment = {
  messageId: string;
  threadId: string;
  sender: string;
  senderName: string;
  subject: string;
  filename: string;
  mimeType: string;
  csvContent: string;
};

export class GmailApiClient {
  constructor(
    private readonly accessToken: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async attempt<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`${GMAIL_API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });

    if (response.status === 401) {
      // The access token was rejected; the grant needs attention rather than a
      // tight retry loop.
      throw new NeedsReauthorizationError("Gmail rejected the access token. Reconnect Gmail to continue.");
    }
    const payload = (await response.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
    if (!response.ok) {
      // Google error messages can echo request content, so only the status is
      // surfaced.
      throw Object.assign(new Error(`Gmail API request failed (${response.status}).`), { status: response.status });
    }
    if (!payload) throw new Error("Gmail API returned an unreadable response.");
    return payload;
  }

  /**
   * Issues one Gmail request, retrying only when it is safe to do so.
   *
   * Reads are retried on a transport error or a 429/5xx, because a DNS or TLS
   * blip should not fail an entire worker cycle. Writes are never retried: a
   * `messages/send` that fails at the network layer may already have delivered
   * mail, and a duplicate email is worse than a surfaced error.
   */
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const idempotent = (init.method ?? "GET").toUpperCase() === "GET";
    const maxAttempts = idempotent ? 3 : 1;

    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.attempt<T>(path, init);
      } catch (error) {
        const status = (error as { status?: number }).status;
        const retryable = status === undefined || status === 429 || status >= 500;
        if (
          attempt >= maxAttempts ||
          !retryable ||
          error instanceof NeedsReauthorizationError
        ) {
          throw error;
        }
        await new Promise((done) => setTimeout(done, 500 * 2 ** (attempt - 1)));
      }
    }
  }

  /** Lists candidate message ids only; full bodies are fetched on demand. */
  async listCandidateMessages(query: string, maxResults: number): Promise<Array<{ id: string; threadId: string }>> {
    const params = new URLSearchParams({ q: query, maxResults: String(Math.min(Math.max(maxResults, 1), 50)) });
    const payload = await this.request<{ messages?: Array<{ id: string; threadId: string }> }>(
      `/messages?${params.toString()}`,
    );
    return payload.messages ?? [];
  }

  async getMessage(id: string): Promise<GmailMessage> {
    return this.request<GmailMessage>(`/messages/${encodeURIComponent(id)}?format=full`);
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
    const payload = await this.request<{ data?: string; size?: number }>(
      `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    );
    if (!payload.data) throw new Error("Gmail returned an empty attachment body.");
    const buffer = Buffer.from(payload.data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
      throw Object.assign(new Error(`Attachment is ${buffer.byteLength} bytes; the limit is ${MAX_ATTACHMENT_BYTES}.`), {
        permanent: true,
      });
    }
    return buffer;
  }

  /** Sends a raw MIME message, threaded when threadId is supplied. */
  async sendMessage(raw: string, threadId?: string): Promise<{ id: string; threadId: string }> {
    return this.request<{ id: string; threadId: string }>("/messages/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw, ...(threadId ? { threadId } : {}) }),
    });
  }

  /** Marks the source message handled. Only called after a confirmed send. */
  async markHandled(messageId: string, processedLabelIds: string[] = []): Promise<void> {
    await this.request(`/messages/${encodeURIComponent(messageId)}/modify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ removeLabelIds: ["UNREAD"], addLabelIds: processedLabelIds }),
    });
  }
}

// ---------------------------------------------------------------------------
// Message parsing
// ---------------------------------------------------------------------------

export function headerValue(part: GmailPart | undefined, name: string): string {
  return part?.headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/** Extracts the bare address from a From header. */
export function parseAddress(value: string): { email: string; name: string } {
  const angled = value.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (angled) return { name: angled[1].replace(/^"|"$/g, "").trim(), email: angled[2].trim().toLowerCase() };
  return { name: "", email: value.trim().toLowerCase() };
}

/** Finds the first CSV attachment part, by filename or MIME type. */
export function findCsvPart(part: GmailPart | undefined): GmailPart | null {
  if (!part) return null;
  const isCsv =
    part.filename?.toLowerCase().endsWith(".csv") ||
    part.mimeType === "text/csv" ||
    part.mimeType === "application/csv";
  if (isCsv && (part.body?.attachmentId || part.body?.data)) return part;
  for (const child of part.parts ?? []) {
    const found = findCsvPart(child);
    if (found) return found;
  }
  return null;
}

export function decodeBase64Url(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// ---------------------------------------------------------------------------
// Reply construction
// ---------------------------------------------------------------------------

function encodeHeaderValue(value: string): string {
  // RFC 2047 encode non-ASCII so subjects survive transit.
  return /[^\x20-\x7E]/.test(value)
    ? `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`
    : value;
}

export function buildReplySubject(subject: string): string {
  const base = subject.replace(/^(re:\s*)+/i, "").trim() || "Parcel Atlas property reports";
  return `Re: ${base}`;
}

function greeting(ownerName?: string | null, ownerEmail?: string | null): string {
  const normalized = ownerName?.replace(/[\r\n\t]+/g, " ").trim();
  const email = ownerEmail?.replace(/[\r\n\t]+/g, "").trim().toLowerCase();
  if (normalized && email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return `Hello ${normalized} (${email}),`;
  return normalized ? `Hello ${normalized},` : email ? `Hello ${email},` : "Hi,";
}

export type RentReviewEmailContext = {
  address: string;
  currentRent?: number | null;
  bedrooms?: number | null;
  marketRentLow?: number | null;
  marketRentHigh?: number | null;
  marketRentAverage?: number | null;
};

function rentReviewLines(ownerName: string | null | undefined, ownerEmail: string | null | undefined, context: RentReviewEmailContext): string[] | null {
  const current = Number(context.currentRent);
  const average = Number(context.marketRentAverage);
  if (!Number.isFinite(current) || current <= 0 || !Number.isFinite(average) || average <= 0) return null;
  const money = (amount: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(amount);
  const low = Number(context.marketRentLow);
  const high = Number(context.marketRentHigh);
  const range = Number.isFinite(low) && Number.isFinite(high) ? `${money(low)} and ${money(high)}` : `around ${money(average)}`;
  const bedroomText = Number.isFinite(Number(context.bedrooms)) ? `${context.bedrooms}-bedroom properties` : "Comparable properties";
  const aroundMarket = Math.abs(current - average) / average <= 0.02;
  const notice = /\bNSW\b/i.test(context.address)
    ? " NSW rent increases are generally limited to once every 12 months and require at least 60 days written notice, subject to the tenancy agreement and applicable law."
    : " Any rent change should be checked against the tenancy agreement and applicable state or territory requirements.";
  const suggestion = aroundMarket
    ? [`Your tenant is paying ${money(current)}/week, which is around the estimated market rent for your property.`, `It is suggested to keep the rent at the same amount for now.${notice}`]
    : current < average
      ? [`Your tenant is paying ${money(current)}/week, which is below the estimated market rent of ${money(average)}/week.`, `It is suggested to consider increasing the rent toward ${money(average)}/week.${notice}`]
      : [`Your tenant is paying ${money(current)}/week, which is above the estimated market rent of ${money(average)}/week.`, "It is suggested not to increase the rent at this time and to review the rent again at the next appropriate review point."];
  return [
    greeting(ownerName, ownerEmail), "", "Hope you are well.", "",
    `I would like to provide you with the rent review for ${context.address}.`, "",
    "Current rental market status",
    `${bedroomText} in the surrounding area are leased and advertised between ${range} per week, depending on condition.`,
    `Based on the attached rent review, the achievable rent for your property is estimated at ${money(average)}/week.`, "",
    "Suggestion", ...suggestion, "", "Please find the detailed rent review attached.", "",
    "Should you have any further enquiries, please do not hesitate to contact me.", "", "Kind regards,", "Vincent",
  ];
}

export function replyPlainTextBody(reportCount: number, reviewCount: number, ownerName?: string | null, ownerEmailOrContext?: string | null | RentReviewEmailContext, context?: RentReviewEmailContext): string {
  // Keep the original fourth-argument context API working for older callers.
  const ownerEmail = typeof ownerEmailOrContext === "string" ? ownerEmailOrContext : null;
  const rentContext = context ?? (typeof ownerEmailOrContext === "object" ? ownerEmailOrContext : undefined);
  const rentReview = rentContext ? rentReviewLines(ownerName, ownerEmail, rentContext) : null;
  if (rentReview) return rentReview.join("\n");
  const plural = reportCount === 1 ? "" : "s";
  const lines = [
    greeting(ownerName, ownerEmail),
    "",
    `Attached ${reportCount === 1 ? "is" : "are"} your Parcel Atlas rent review report${plural} for the ${reportCount} propert${reportCount === 1 ? "y" : "ies"} matched from your CSV.`,
    "",
    "Each report contains the matched property attributes, qualifying comparable rentals, and the calculated average weekly rent based on Cotality/CoreLogic evidence.",
  ];
  if (reviewCount > 0) {
    lines.push(
      "",
      `${reviewCount} address${reviewCount === 1 ? "" : "es"} could not be matched to a single property and ${reviewCount === 1 ? "was" : "were"} left for manual review, so ${reviewCount === 1 ? "it is" : "they are"} not included here.`,
    );
  }
  lines.push("", "Kind regards,", "Vincent");
  return lines.join("\n");
}

export function replyHtmlBody(reportCount: number, reviewCount: number, reportNames: string[], ownerName?: string | null, ownerEmailOrContext?: string | null | RentReviewEmailContext, context?: RentReviewEmailContext): string {
  const escape = (value: string) =>
    value.replace(/[&<>"']/g, (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character] ?? character);
  const items = reportNames.map((name) => `<li>${escape(name)}</li>`).join("");
  const review =
    reviewCount > 0
      ? `<p style="color:#5f4a18;background:#fff0c7;border-left:4px solid #d69c1d;padding:10px 12px;">${reviewCount} address${reviewCount === 1 ? "" : "es"} could not be matched to a single property and ${reviewCount === 1 ? "was" : "were"} left for manual review.</p>`
      : "";
  // Keep the original fifth-argument context API working for older callers.
  const ownerEmail = typeof ownerEmailOrContext === "string" ? ownerEmailOrContext : null;
  const rentContext = context ?? (typeof ownerEmailOrContext === "object" ? ownerEmailOrContext : undefined);
  const rentReview = rentContext ? rentReviewLines(ownerName, ownerEmail, rentContext) : null;
  if (rentReview) {
    return ["<div style='font-family:Arial,sans-serif;font-size:14px;color:#172022;line-height:1.55;max-width:680px;'>", ...rentReview.map((line) => line ? `<p>${escape(line)}</p>` : ""), "</div>"].join("");
  }
  return [
    '<div style="font-family:Arial,sans-serif;font-size:14px;color:#172022;line-height:1.5;">',
    `<p>${escape(greeting(ownerName, ownerEmail))}</p>`,
    `<p>Attached ${reportCount === 1 ? "is" : "are"} your Parcel Atlas rent review report${reportCount === 1 ? "" : "s"} for the <strong>${reportCount}</strong> propert${reportCount === 1 ? "y" : "ies"} matched from your CSV.</p>`,
    "<p>Each report contains the matched property attributes, qualifying comparable rentals, and the calculated average weekly rent based on Cotality/CoreLogic evidence.</p>",
    items ? `<ul>${items}</ul>` : "",
    review,
    "<p>Kind regards,<br>Vincent</p>",
    "</div>",
  ].join("");
}

export type ReplyAttachment = { filename: string; mimeType: string; content: string | Buffer };

/**
 * Builds a base64url MIME message: multipart/mixed wrapping a
 * multipart/alternative text+HTML body plus every report attachment.
 */
export function buildMimeReply(options: {
  to: string;
  subject: string;
  inReplyTo?: string;
  references?: string;
  plainText: string;
  html: string;
  attachments: ReplyAttachment[];
}): string {
  const mixed = `mixed_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const alternative = `alt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

  const lines: string[] = [
    `To: ${options.to}`,
    `Subject: ${encodeHeaderValue(options.subject)}`,
    "MIME-Version: 1.0",
  ];
  // Threading headers make Gmail attach the reply to the original conversation.
  if (options.inReplyTo) lines.push(`In-Reply-To: ${options.inReplyTo}`);
  if (options.references) lines.push(`References: ${options.references}`);

  lines.push(
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    "",
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alternative}"`,
    "",
    `--${alternative}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(options.plainText, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n"),
    "",
    `--${alternative}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(options.html, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n"),
    "",
    `--${alternative}--`,
    "",
  );

  for (const attachment of options.attachments) {
    const buffer = Buffer.isBuffer(attachment.content)
      ? attachment.content
      : Buffer.from(attachment.content, "utf8");
    lines.push(
      `--${mixed}`,
      `Content-Type: ${attachment.mimeType}; name="${attachment.filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      "",
      buffer.toString("base64").replace(/(.{76})/g, "$1\r\n"),
      "",
    );
  }

  lines.push(`--${mixed}--`, "");
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}
