/** Outlook / Microsoft Graph mailbox adapter for CSV intake and report replies. */
import { getOutlookConnection, markOutlookConnectionStatus, touchOutlookConnection } from "./db";
import { GRAPH_BASE, OutlookNeedsReauthorizationError, readOutlookOAuthConfig, refreshOutlookAccessToken, type FetchLike } from "./outlook-oauth";
import { decryptSecret } from "./token-crypto";
import type { Logger } from "./logger";
import type { ReplyAttachment } from "./gmail-api";

const MAX_ATTACHMENT_BYTES = 1_000_000;
export type OutlookAttachment = { messageId: string; threadId: string; sender: string; senderName: string; subject: string; filename: string; mimeType: string; csvContent: string };

export class OutlookGraphClient {
  constructor(private readonly accessToken: string, private readonly fetchImpl: FetchLike = fetch) {}
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${GRAPH_BASE}${path}`, { ...init, headers: { Authorization: `Bearer ${this.accessToken}`, Accept: "application/json", ...(init.headers ?? {}) }, cache: "no-store", signal: AbortSignal.timeout(30_000) });
    if (response.status === 401) throw new OutlookNeedsReauthorizationError("Microsoft Graph rejected the Outlook access token. Reconnect Outlook to continue.");
    const payload = await response.json().catch(() => null) as T | null;
    if (!response.ok || !payload) throw new Error(`Microsoft Graph request failed (${response.status}).`);
    return payload;
  }
  async listCsvCandidates(maxResults: number) {
    const params = new URLSearchParams({ "$select": "id,conversationId,subject,from,hasAttachments,isRead", "$top": String(Math.min(Math.max(maxResults * 4, 10), 50)), "$orderby": "receivedDateTime desc" });
    const payload = await this.request<{ value?: Array<{ id: string; conversationId?: string; subject?: string; hasAttachments?: boolean; isRead?: boolean; from?: { emailAddress?: { address?: string; name?: string } } }> }>(`/me/mailFolders/inbox/messages?${params}`);
    return (payload.value ?? []).filter((message) => message.hasAttachments && !message.isRead).slice(0, maxResults);
  }
  async csvAttachment(messageId: string) {
    const payload = await this.request<{ value?: Array<{ "@odata.type"?: string; name?: string; contentType?: string; contentBytes?: string; size?: number }> }>(`/me/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,contentType,contentBytes,size`);
    const attachment = (payload.value ?? []).find((item) => item.name?.toLowerCase().endsWith(".csv") || item.contentType === "text/csv" || item.contentType === "application/csv");
    if (!attachment?.contentBytes) return null;
    const buffer = Buffer.from(attachment.contentBytes, "base64");
    if (buffer.byteLength > MAX_ATTACHMENT_BYTES) throw Object.assign(new Error(`Attachment is ${buffer.byteLength} bytes; the limit is ${MAX_ATTACHMENT_BYTES}.`), { permanent: true });
    return { filename: attachment.name || "attachment.csv", mimeType: (attachment.contentType || "text/csv").split(";")[0], content: buffer.toString("utf8") };
  }
  async sendReply(sourceMessageId: string, comment: string, attachments: ReplyAttachment[]): Promise<void> {
    const draft = await this.request<{ id?: string }>(`/me/messages/${encodeURIComponent(sourceMessageId)}/createReply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ comment }) });
    if (!draft.id) throw new Error("Microsoft Graph did not create a reply draft.");
    for (const attachment of attachments) await this.request(`/me/messages/${encodeURIComponent(draft.id)}/attachments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ "@odata.type": "#microsoft.graph.fileAttachment", name: attachment.filename, contentType: attachment.mimeType, contentBytes: Buffer.isBuffer(attachment.content) ? attachment.content.toString("base64") : Buffer.from(attachment.content, "utf8").toString("base64") }) });
    await this.request(`/me/messages/${encodeURIComponent(draft.id)}/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  }
  async markHandled(messageId: string) { await this.request(`/me/messages/${encodeURIComponent(messageId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isRead: true }) }); }
}

export async function openOutlookMailbox(deps: { logger: Logger; fetchImpl?: FetchLike; env?: NodeJS.ProcessEnv }) {
  const connection = await getOutlookConnection();
  if (!connection?.refresh_token_encrypted || connection.status === "needs_reauthorization") throw new OutlookNeedsReauthorizationError("Outlook is not connected. Use Connect Outlook in Parcel Atlas to authorize the mailbox.");
  const config = readOutlookOAuthConfig(deps.env ?? process.env);
  let refreshToken: string; try { refreshToken = decryptSecret(connection.refresh_token_encrypted); } catch { await markOutlookConnectionStatus("needs_reauthorization", "token_undecryptable"); throw new OutlookNeedsReauthorizationError("The stored Outlook token could not be decrypted."); }
  try { const tokens = await refreshOutlookAccessToken({ refreshToken, config, fetchImpl: deps.fetchImpl }); await touchOutlookConnection(); deps.logger.info("outlook.oauth.token_refreshed", { account: connection.email_masked }); return new OutlookGraphClient(tokens.accessToken, deps.fetchImpl ?? fetch); }
  catch (error) { if (error instanceof OutlookNeedsReauthorizationError) await markOutlookConnectionStatus("needs_reauthorization", "invalid_grant"); throw error; }
}
export async function discoverOutlookCsvAttachments(client: OutlookGraphClient, options: { maxMessages?: number; logger: Logger }): Promise<OutlookAttachment[]> {
  const messages = await client.listCsvCandidates(options.maxMessages ?? 5); const result: OutlookAttachment[] = [];
  for (const message of messages) {
    const attachment = await client.csvAttachment(message.id); if (!attachment) continue;
    const sender = message.from?.emailAddress?.address?.toLowerCase() ?? ""; if (!sender) continue;
    result.push({ messageId: message.id, threadId: message.conversationId ?? message.id, sender, senderName: message.from?.emailAddress?.name ?? "", subject: message.subject || "CSV rent review request", filename: attachment.filename, mimeType: attachment.mimeType, csvContent: attachment.content });
  }
  options.logger.info("outlook.messages.listed", { candidates: messages.length, csvAttachments: result.length }); return result;
}
export async function sendOutlookReportReply(client: OutlookGraphClient, params: { sourceMessageId: string; attachments: ReplyAttachment[]; reviewCount: number; ownerName?: string | null; ownerEmail?: string | null; logger: Logger }) {
  if (!params.attachments.length) throw new Error("Refusing to send a reply with no report attachments.");
  const reportWord = params.attachments.length === 1 ? "report" : "reports";
  const review = params.reviewCount ? ` ${params.reviewCount} address row(s) require manual review and are not included.` : "";
  const ownerName = params.ownerName?.replace(/[\r\n\t]+/g, " ").trim();
  const ownerEmail = params.ownerEmail?.replace(/[\r\n\t]+/g, "").trim().toLowerCase();
  const salutation = ownerName ? `Hello ${ownerName}${ownerEmail ? ` (${ownerEmail})` : ""},` : ownerEmail ? `Hello ${ownerEmail},` : "Hi,";
  await client.sendReply(params.sourceMessageId, `${salutation}\n\nAttached ${params.attachments.length} Parcel Atlas rent review ${reportWord}.${review}\n\nKind regards,\nVincent`, params.attachments);
  await client.markHandled(params.sourceMessageId); params.logger.info("outlook.reply.sent", { attachments: params.attachments.length });
}
