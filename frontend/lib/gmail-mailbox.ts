/**
 * Mailbox adapter used by the durable worker.
 *
 * Loads the encrypted refresh token from Neon, obtains a short-lived access
 * token, and exposes discovery plus reply delivery over the Gmail API. No
 * Browserless, Playwright, cookie or password is involved.
 *
 * Access tokens are held in memory for the cycle only and never persisted.
 */

import {
  getGmailConnection,
  markGmailConnectionStatus,
  touchGmailConnection,
} from "./db";
import {
  GmailApiClient,
  findCsvPart,
  headerValue,
  parseAddress,
  decodeBase64Url,
  buildMimeReply,
  buildReplySubject,
  replyHtmlBody,
  replyPlainTextBody,
  type DiscoveredAttachment,
  type ReplyAttachment,
} from "./gmail-api";
import {
  NeedsReauthorizationError,
  readOAuthClientConfig,
  refreshAccessToken,
  type FetchLike,
} from "./gmail-oauth";
import type { Logger } from "./logger";
import { decryptSecret } from "./token-crypto";

/** Only messages carrying a CSV attachment are candidates. */
export const DEFAULT_INBOX_QUERY = "has:attachment filename:csv -from:me";

export type MailboxDeps = {
  logger: Logger;
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
};

/**
 * Opens an authenticated Gmail client.
 *
 * A revoked or invalid grant is recorded as needs_reauthorization in Neon and
 * raised, so the worker stops that cycle instead of retry looping.
 */
export async function openMailbox(deps: MailboxDeps): Promise<GmailApiClient> {
  const connection = await getGmailConnection();
  if (!connection || !connection.refresh_token_encrypted) {
    throw new NeedsReauthorizationError(
      "Gmail is not connected. Use Connect Gmail in Parcel Atlas to authorize the mailbox.",
    );
  }
  if (connection.status === "needs_reauthorization") {
    throw new NeedsReauthorizationError("The Gmail authorization was revoked. Reconnect Gmail to continue.");
  }

  const config = readOAuthClientConfig(deps.env ?? process.env);

  let refreshToken: string;
  try {
    refreshToken = decryptSecret(connection.refresh_token_encrypted);
  } catch (error) {
    // An undecryptable token is unusable; surface it as a reconnect, not a retry.
    await markGmailConnectionStatus("needs_reauthorization", "token_undecryptable");
    throw new NeedsReauthorizationError(
      error instanceof Error ? error.message : "The stored Gmail token could not be decrypted.",
    );
  }

  try {
    const { accessToken } = await refreshAccessToken({
      refreshToken,
      config,
      fetchImpl: deps.fetchImpl,
    });
    await touchGmailConnection();
    deps.logger.info("gmail.oauth.token_refreshed", { account: connection.email_masked });
    return new GmailApiClient(accessToken, deps.fetchImpl ?? fetch);
  } catch (error) {
    if (error instanceof NeedsReauthorizationError) {
      await markGmailConnectionStatus("needs_reauthorization", "invalid_grant");
      deps.logger.error("gmail.oauth.needs_reauthorization", { account: connection.email_masked });
    }
    throw error;
  }
}

/**
 * Finds CSV attachments. Message and thread ids are returned so the caller can
 * build an idempotency key that survives retries and future scheduled runs.
 */
export async function discoverCsvAttachments(
  client: GmailApiClient,
  options: { query?: string; maxMessages?: number; logger: Logger },
): Promise<DiscoveredAttachment[]> {
  const query = options.query ?? DEFAULT_INBOX_QUERY;
  const candidates = await client.listCandidateMessages(query, options.maxMessages ?? 5);
  options.logger.info("gmail.messages.listed", { candidates: candidates.length, query });

  const found: DiscoveredAttachment[] = [];
  for (const candidate of candidates) {
    try {
      // Full bodies are fetched only for listed candidates, not the whole inbox.
      const message = await client.getMessage(candidate.id);
      const csvPart = findCsvPart(message.payload);
      if (!csvPart) {
        options.logger.debug("gmail.message.no_csv", { messageId: candidate.id });
        continue;
      }

      const from = parseAddress(headerValue(message.payload, "From"));
      const subject = headerValue(message.payload, "Subject") || "CSV rent review request";

      const bytes = csvPart.body?.attachmentId
        ? await client.getAttachment(message.id, csvPart.body.attachmentId)
        : decodeBase64Url(csvPart.body?.data ?? "");
      if (!bytes.byteLength) {
        options.logger.warn("gmail.attachment.empty", { messageId: candidate.id });
        continue;
      }

      found.push({
        messageId: message.id,
        threadId: message.threadId,
        sender: from.email,
        senderName: from.name,
        subject,
        filename: csvPart.filename || "attachment.csv",
        mimeType: (csvPart.mimeType || "text/csv").split(";")[0],
        csvContent: bytes.toString("utf8"),
      });
      options.logger.info("gmail.attachment.discovered", {
        messageId: message.id,
        threadId: message.threadId,
        filename: csvPart.filename,
        bytes: bytes.byteLength,
      });
    } catch (error) {
      if (error instanceof NeedsReauthorizationError) throw error;
      options.logger.warn("gmail.message.failed", {
        messageId: candidate.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return found;
}

/**
 * Sends exactly one threaded reply carrying every completed report, then marks
 * the source message handled only after Gmail confirms the send.
 */
export async function sendReportReply(
  client: GmailApiClient,
  params: {
    to: string;
    subject: string;
    threadId?: string;
    sourceMessageId?: string;
    rfc822MessageId?: string;
    attachments: ReplyAttachment[];
    reviewCount?: number;
    logger: Logger;
  },
): Promise<{ id: string; threadId: string }> {
  if (!params.to) throw new Error("Cannot send a reply without a recipient address.");
  if (!params.attachments.length) throw new Error("Refusing to send a reply with no report attachments.");

  const reviewCount = params.reviewCount ?? 0;
  const raw = buildMimeReply({
    to: params.to,
    subject: buildReplySubject(params.subject),
    inReplyTo: params.rfc822MessageId,
    references: params.rfc822MessageId,
    plainText: replyPlainTextBody(params.attachments.length, reviewCount),
    html: replyHtmlBody(params.attachments.length, reviewCount, params.attachments.map((item) => item.filename)),
    attachments: params.attachments,
  });

  const sent = await client.sendMessage(raw, params.threadId);
  params.logger.info("gmail.reply.sent", {
    to: params.to,
    attachments: params.attachments.length,
    threadId: sent.threadId,
  });

  if (params.sourceMessageId) {
    try {
      await client.markHandled(params.sourceMessageId);
      params.logger.info("gmail.source.marked_handled", { messageId: params.sourceMessageId });
    } catch (error) {
      // The reply is already delivered, so this must not fail the job; the
      // durable reply record prevents a duplicate send on the next run.
      params.logger.warn("gmail.source.mark_failed", {
        messageId: params.sourceMessageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return sent;
}
