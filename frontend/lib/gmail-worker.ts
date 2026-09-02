/**
 * Browserless-backed Gmail automation for the Render worker.
 *
 * Session state lives in Neon, not on the worker's disk, so a fresh Render
 * instance can resume without a local profile. A Google challenge is reported
 * as a distinct, non-retryable condition rather than being retried forever.
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

import { invalidateGmailSession, loadGmailSession, saveGmailSession } from "./db";
import type { Logger } from "./logger";
import { redact } from "./logger";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Google requires human interaction; the job must stop rather than retry. */
export class NeedsReauthenticationError extends Error {
  readonly needsReauthentication = true;
  constructor(message: string) {
    super(message);
    this.name = "NeedsReauthenticationError";
  }
}

const CHALLENGE_URL_MARKERS = ["challenge", "signin/rejected", "deniedsigninrejected", "disabled/explanation"];

export function buildBrowserlessEndpoint(config: { wsEndpoint?: string; apiKey?: string }): string {
  let endpoint = config.wsEndpoint?.trim() || "";
  if (!endpoint && config.apiKey?.trim()) {
    endpoint = `wss://production-sfo.browserless.io?token=${config.apiKey.trim()}`;
  }
  if (!endpoint) {
    throw new Error("Browserless is not configured. Set BROWSERLESS_WS_ENDPOINT or BROWSERLESS_API_KEY.");
  }
  if (!endpoint.includes("stealth=")) {
    endpoint += (endpoint.includes("?") ? "&" : "?") + "stealth=true&--disable-blink-features=AutomationControlled";
  }
  return endpoint;
}

export function isChallengeUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return CHALLENGE_URL_MARKERS.some((marker) => lower.includes(marker));
}

export type GmailSession = {
  browser: Browser;
  context: BrowserContext;
  close(): Promise<void>;
};

export type GmailWorkerConfig = {
  wsEndpoint?: string;
  apiKey?: string;
  username: string;
  password: string;
  logger: Logger;
};

async function sessionIsValid(context: BrowserContext): Promise<boolean> {
  const page = await context.newPage();
  try {
    await page.goto("https://mail.google.com/mail/u/0/#inbox", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(2_500);
    const url = page.url();
    if (isChallengeUrl(url)) throw new NeedsReauthenticationError(`Google presented a challenge at ${url}`);
    return url.startsWith("https://mail.google.com") && !url.includes("accounts.google.com");
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function performLogin(page: Page, config: GmailWorkerConfig): Promise<void> {
  const { username, password, logger } = config;
  logger.info("gmail.login.start");

  await page.goto("https://accounts.google.com/signin/v2/identifier", {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  await page.waitForTimeout(2_000);

  const emailInput = page.locator('input[type="email"], input[name="identifier"]').first();
  if (await emailInput.isVisible({ timeout: 8_000 }).catch(() => false)) {
    await emailInput.fill(username);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(3_500);
  }

  if (isChallengeUrl(page.url())) {
    throw new NeedsReauthenticationError(`Google challenged the account before the password step (${page.url()}).`);
  }

  const passwordInput = page
    .locator('input[name="Passwd"], input[type="password"]:not([name="hiddenPassword"]):not([aria-hidden="true"])')
    .first();
  await passwordInput.waitFor({ state: "visible", timeout: 25_000 });
  await passwordInput.fill(password);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(6_000);

  if (isChallengeUrl(page.url())) {
    throw new NeedsReauthenticationError(
      `Google presented an MFA/CAPTCHA challenge after the password step (${page.url()}). Manual re-authentication is required.`,
    );
  }

  for (const label of ["Not now", "No thanks", "Skip", "Continue"]) {
    const button = page.locator(`button:has-text("${label}")`).first();
    if (await button.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await button.click().catch(() => undefined);
      await page.waitForTimeout(1_200);
    }
  }

  await page.goto("https://mail.google.com/mail/u/0/#inbox", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(3_000);
  const finalUrl = page.url();
  if (isChallengeUrl(finalUrl)) {
    throw new NeedsReauthenticationError(`Google challenged the session after login (${finalUrl}).`);
  }
  if (!finalUrl.startsWith("https://mail.google.com")) {
    throw new Error(`Gmail login did not reach the mailbox; ended at ${redact(finalUrl)}`);
  }
  logger.info("gmail.login.success");
}

/**
 * Opens an authenticated Gmail session. Tries the stored session first, then
 * exactly one password login. A Google challenge aborts without further tries.
 */
export async function openGmailSession(config: GmailWorkerConfig): Promise<GmailSession> {
  const endpoint = buildBrowserlessEndpoint(config);
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 45_000 });
  const close = async () => {
    await browser.close().catch(() => undefined);
  };

  try {
    const storageState = (await loadGmailSession()) as never;
    if (storageState) {
      const context = await browser.newContext({
        storageState,
        userAgent: USER_AGENT,
        viewport: { width: 1280, height: 900 },
        locale: "en-US",
        timezoneId: "Australia/Sydney",
      });
      if (await sessionIsValid(context)) {
        config.logger.info("gmail.session.reused");
        return { browser, context, close };
      }
      config.logger.warn("gmail.session.expired");
      await context.close().catch(() => undefined);
      await invalidateGmailSession();
    }

    if (!config.username || !config.password) {
      throw new NeedsReauthenticationError(
        "No valid stored Gmail session and no bot credentials configured for an automatic login.",
      );
    }

    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
      timezoneId: "Australia/Sydney",
    });
    const page = await context.newPage();
    try {
      await performLogin(page, config);
    } finally {
      await page.close().catch(() => undefined);
    }
    await saveGmailSession(await context.storageState());
    config.logger.info("gmail.session.saved");
    return { browser, context, close };
  } catch (error) {
    await close();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Inbox discovery
// ---------------------------------------------------------------------------

export type DiscoveredCsv = {
  sender: string;
  subject: string;
  threadId: string | null;
  fileName: string;
  mimeType: string | null;
  csvContent: string;
};

export async function discoverCsvEmails(
  context: BrowserContext,
  options: { query?: string; maxEmails?: number; logger: Logger },
): Promise<DiscoveredCsv[]> {
  const query = options.query ?? "has:attachment filename:csv -from:me";
  const maxEmails = options.maxEmails ?? 5;
  const page = await context.newPage();
  const found: DiscoveredCsv[] = [];

  try {
    await page.goto("https://mail.google.com/mail/u/0/#inbox", { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(3_000);

    const searchInput = page.locator('input[name="q"], input[aria-label*="Search"]').first();
    if (await searchInput.isVisible({ timeout: 6_000 }).catch(() => false)) {
      await searchInput.click();
      await searchInput.fill(query);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(4_000);
    }

    const threadCount = await page.locator('div[role="main"] tr.zA').count();
    options.logger.info("gmail.threads.found", { threadCount, query });

    for (let index = 0; index < Math.min(threadCount, maxEmails); index += 1) {
      try {
        await page.goto("https://mail.google.com/mail/u/0/#search/" + encodeURIComponent(query), {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        await page.waitForTimeout(2_500);
        const rows = page.locator('div[role="main"] tr.zA');
        if (index >= (await rows.count())) break;
        await rows.nth(index).click();
        await page.waitForTimeout(3_000);

        const subjectEl = page.locator("h2.hP").first();
        const subject = (await subjectEl.isVisible({ timeout: 4_000 }).catch(() => false))
          ? (await subjectEl.innerText()).trim()
          : "Property review request";

        const threadId =
          (await page.locator("h2[data-thread-perm-id]").first().getAttribute("data-thread-perm-id").catch(() => null)) ??
          null;

        let sender = "";
        for (const selector of ["span[email]", "span[data-hovercard-id]", ".gD[email]", ".zF[email]"]) {
          const element = page.locator(selector).first();
          if (await element.isVisible({ timeout: 1_200 }).catch(() => false)) {
            sender = (
              (await element.getAttribute("email")) ??
              (await element.getAttribute("data-hovercard-id")) ??
              (await element.innerText().catch(() => ""))
            )
              .trim()
              .toLowerCase();
            if (sender) break;
          }
        }

        const attachments = await page.locator("[download_url]").all();
        let csvContent = "";
        let fileName = "";
        let mimeType: string | null = null;

        for (const node of attachments) {
          const raw = (await node.getAttribute("download_url")) ?? "";
          if (!raw.toLowerCase().includes(".csv")) continue;
          const parts = raw.split(":");
          if (parts.length < 3) continue;
          mimeType = parts[0] || null;
          fileName = decodeURIComponent(parts[1] || "attachment.csv");
          const directUrl = parts.slice(2).join(":");
          const response = await context.request.get(directUrl, { timeout: 30_000 });
          if (response.ok()) {
            csvContent = (await response.body()).toString("utf8");
            break;
          }
        }

        if (!csvContent) {
          options.logger.warn("gmail.thread.no_csv", { threadIndex: index + 1 });
          continue;
        }

        found.push({ sender, subject, threadId, fileName, mimeType, csvContent });
        options.logger.info("gmail.csv.discovered", { sender, fileName, bytes: csvContent.length, threadId });
      } catch (error) {
        options.logger.warn("gmail.thread.error", {
          threadIndex: index + 1,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    await page.close().catch(() => undefined);
  }

  return found;
}

// ---------------------------------------------------------------------------
// Reply delivery
// ---------------------------------------------------------------------------

export function composeReplyBody(reportCount: number): string {
  const plural = reportCount === 1 ? "y" : "ies";
  return [
    "Hi,",
    "",
    `Please find attached your Parcel Atlas property rent review report${reportCount === 1 ? "" : "s"} for the ${reportCount} propert${plural} submitted.`,
    "",
    "Each report includes the matched property attributes, qualifying comparable rentals, and the calculated average weekly rent based on live Cotality/CoreLogic evidence.",
    "",
    "Kind regards,",
    "Parcel Atlas",
  ].join("\n");
}

/**
 * Replies to the source thread with every completed report attached.
 * Returns only after Gmail confirms "Message sent", so a draft is never
 * mistaken for a delivered reply.
 */
export async function sendReportReply(
  context: BrowserContext,
  params: {
    recipient: string;
    subject: string;
    attachments: Array<{ name: string; mimeType: string; buffer: Buffer }>;
    logger: Logger;
  },
): Promise<void> {
  if (!params.recipient) throw new Error("Cannot send a reply without a recipient address.");
  if (!params.attachments.length) throw new Error("Refusing to send a reply with no report attachments.");

  const page = await context.newPage();
  try {
    await page.goto("https://mail.google.com/mail/u/0/#inbox", { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(3_000);

    const searchInput = page.locator('input[name="q"]').first();
    if (await searchInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await searchInput.click();
      await searchInput.fill(`from:${params.recipient} has:attachment filename:csv`);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(3_000);
    }

    let usedCompose = false;
    const firstRow = page.locator('div[role="main"] tr.zA').first();
    if (await firstRow.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await firstRow.click();
      await page.waitForTimeout(3_000);
      const replyButton = page.locator('button[data-tooltip*="Reply"], button[aria-label*="Reply"]').first();
      if (await replyButton.isVisible({ timeout: 6_000 }).catch(() => false)) {
        await replyButton.click();
      } else {
        await page.keyboard.press("r");
      }
      await page.waitForTimeout(2_500);
    } else {
      usedCompose = true;
      params.logger.warn("gmail.reply.compose_fallback");
      const composeButton = page.locator('div[gh="cm"], [aria-label*="Compose"]').first();
      if (await composeButton.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await composeButton.click();
      } else {
        await page.keyboard.press("c");
      }
      await page.waitForTimeout(2_500);

      const toField = page
        .locator('input[aria-label="To recipients"], input[aria-label^="To"], textarea[name="to"], input[name="to"]')
        .first();
      await toField.waitFor({ state: "visible", timeout: 12_000 });
      await toField.fill(params.recipient);
      await page.keyboard.press("Enter");
      // Gmail only sends to a committed recipient chip, never to typed text.
      await page
        .locator(`[email="${params.recipient}"], [data-hovercard-id="${params.recipient}"]`)
        .last()
        .waitFor({ state: "visible", timeout: 12_000 });

      const subjectField = page.locator('input[name="subjectbox"]').first();
      if (await subjectField.isVisible({ timeout: 4_000 }).catch(() => false)) {
        await subjectField.fill(params.subject);
      }
    }

    const bodyArea = page
      .locator(
        'div[contenteditable="true"][aria-label="Message Body"], div[role="textbox"][aria-label*="Message Body"], div[contenteditable="true"][aria-label*="Message Body"]',
      )
      .first();
    await bodyArea.waitFor({ state: "visible", timeout: 15_000 });
    const body = composeReplyBody(params.attachments.length);
    await bodyArea.fill(body);
    // A blank body is a hard failure, not a warning.
    const renderedBody = (await bodyArea.innerText()).trim();
    if (!renderedBody.includes("Please find attached your Parcel Atlas property rent review report")) {
      throw new Error("Gmail did not accept the report email body; leaving the message unsent.");
    }

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(
      params.attachments.map((attachment) => ({
        name: attachment.name,
        mimeType: attachment.mimeType,
        buffer: attachment.buffer,
      })),
    );

    // Every attachment must show its chip before Send becomes trustworthy.
    for (const attachment of params.attachments) {
      await page.getByText(attachment.name, { exact: false }).last().waitFor({ state: "visible", timeout: 60_000 });
    }

    const sendButton = page
      .locator('div[role="button"][data-tooltip^="Send"], div[role="button"][aria-label^="Send"]')
      .first();
    await sendButton.waitFor({ state: "visible", timeout: 12_000 });
    if ((await sendButton.getAttribute("aria-disabled")) === "true") {
      throw new Error("Gmail Send is disabled; the draft is missing a recipient or attachment.");
    }
    await sendButton.click();
    await page.getByText(/Message sent/i).last().waitFor({ state: "visible", timeout: 30_000 });

    params.logger.info("gmail.reply.sent", {
      recipient: params.recipient,
      attachments: params.attachments.length,
      usedCompose,
    });
  } finally {
    await page.close().catch(() => undefined);
  }
}
