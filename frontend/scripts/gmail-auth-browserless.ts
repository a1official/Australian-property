#!/usr/bin/env tsx
/**
 * Authenticate the bot mailbox interactively, inside Browserless.
 *
 * Why this beats seeding a locally captured session: the cookies are minted on
 * the same Browserless IP and browser fingerprint that the worker later reuses,
 * so there is no IP or device change for Google to distrust. A session captured
 * on a home IP and replayed from a datacentre IP is what kept getting refused.
 *
 * Flow:
 *   1. Connect to Browserless and open the Google sign-in page.
 *   2. Mint an interactive live URL and print it.
 *   3. You open that URL and complete the login and 2FA by hand.
 *   4. On reaching the inbox, the storage state is saved to Neon.
 *
 * The password is never typed by this script, so no automated login attempt is
 * made and the login rate limiter is not consumed.
 *
 *   pnpm gmail:auth:remote
 */

import { chromium } from "playwright-core";
import { existsSync, readFileSync } from "node:fs";
import * as nodePath from "node:path";
import process from "node:process";

import { closePool, loadGmailSession, recordLoginSuccess, resetLoginGate, saveGmailSession } from "../lib/db";
import { buildBrowserlessEndpoint, isChallengeUrl } from "../lib/gmail-worker";
import { createLogger, redact } from "../lib/logger";

const log = createLogger({ script: "gmail-auth-browserless" });

function loadLocalEnv(): void {
  for (const candidate of [
    nodePath.resolve(process.cwd(), "..", ".env"),
    nodePath.resolve(process.cwd(), ".env"),
    nodePath.resolve(process.cwd(), ".env.local"),
  ]) {
    if (!existsSync(candidate)) continue;
    for (const line of readFileSync(candidate, "utf8").split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  }
}

loadLocalEnv();

/**
 * Browserless caps a single session at the plan maximum (120s on the current
 * plan), and a live URL cannot outlive its session. Requesting more is rejected
 * outright, so clamp to the cap and tell the user how long they really have.
 */
const PLAN_MAX_SESSION_MS = Number(process.env.BROWSERLESS_MAX_SESSION_MS || 120_000);
const REQUESTED_WINDOW_MS = Number(process.env.AUTH_WINDOW_MS || PLAN_MAX_SESSION_MS);
const WINDOW_MS = Math.min(Math.max(REQUESTED_WINDOW_MS, 30_000), PLAN_MAX_SESSION_MS);

async function run(): Promise<void> {
  const endpoint = buildBrowserlessEndpoint({
    wsEndpoint: process.env.BROWSERLESS_WS_ENDPOINT,
    apiKey: process.env.BROWSERLESS_API_KEY,
  });
  const username = process.env.GMAIL_USERNAME || "";

  log.info("auth.connecting", { endpoint: redact(endpoint) });
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 60_000 });

  try {
    // Match the worker's context settings exactly. A fingerprint mismatch
    // between authentication and reuse is itself a reason for Google to
    // re-challenge the session later.
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
      timezoneId: "Australia/Sydney",
    });
    const page = await context.newPage();

    await page.goto("https://accounts.google.com/signin/v2/identifier", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(2_000);

    const cdp = await context.newCDPSession(page);
    const response = (await cdp.send("Browserless.liveURL" as never, {
      timeout: WINDOW_MS,
      interactable: true,
      quality: 90,
    } as never)) as unknown as { error: string | null; liveURL: string | null; liveURLId?: string };

    // Browserless reports failures in the payload rather than by throwing, so
    // an unchecked response silently yields a null URL.
    if (response.error || !response.liveURL) {
      log.error("auth.liveurl_failed", {
        error: response.error ?? "Browserless returned no live URL.",
        requestedMs: WINDOW_MS,
        planMaxMs: PLAN_MAX_SESSION_MS,
      });
      return;
    }

    const seconds = Math.floor(WINDOW_MS / 1000);
    console.log("\n" + "=".repeat(78));
    console.log("  OPEN THIS URL NOW AND SIGN IN BY HAND");
    console.log("=".repeat(78));
    console.log(`\n${response.liveURL}\n`);
    console.log(`  Account:  ${username || "(GMAIL_USERNAME not set)"}`);
    console.log(`  Window:   ${seconds}s (Browserless plan session cap)`);
    console.log("\n  Be quick, and have your 2FA device already in hand:");
    console.log("    1. Enter the email address, then the password.");
    console.log("    2. Approve the 2FA prompt immediately.");
    console.log("    3. Accept any 'Stay signed in' prompt.");
    console.log("\n  The session saves as soon as the inbox is detected. If the window");
    console.log("  expires first, just re-run this command and try again.");
    console.log("  Cookies are minted on the Browserless IP the worker reuses.\n");
    console.log("=".repeat(78) + "\n");

    log.info("auth.awaiting_human", { windowMs: WINDOW_MS, liveUrlId: response.liveURLId });

    // Poll for the inbox rather than requiring the user to close the tab, so a
    // successful login is captured even if they leave the viewer open.
    const deadline = Date.now() + WINDOW_MS;
    let authenticated = false;
    let lastReported = "";

    while (Date.now() < deadline) {
      // Poll frequently: the usable window is short.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      let url: string;
      try {
        url = page.url();
      } catch {
        log.warn("auth.page_closed", { note: "The live session ended before the inbox was reached." });
        break;
      }

      const stage = url.includes("mail.google.com")
        ? "inbox"
        : isChallengeUrl(url)
          ? "challenge"
          : url.includes("accounts.google.com")
            ? "signing-in"
            : "other";
      if (stage !== lastReported) {
        log.info("auth.progress", { stage });
        lastReported = stage;
      }

      if (url.startsWith("https://mail.google.com") && !url.includes("accounts.google.com")) {
        // Let Gmail set its post-login cookies, but stay inside the window.
        await page.waitForTimeout(2_500);
        const inboxReady = await page
          .locator('div[role="main"], input[name="q"]')
          .first()
          .isVisible({ timeout: 8_000 })
          .catch(() => false);
        if (inboxReady) {
          authenticated = true;
          break;
        }
      }
    }

    if (!authenticated) {
      log.error("auth.window_expired", {
        windowMs: WINDOW_MS,
        planMaxMs: PLAN_MAX_SESSION_MS,
        fix: "Re-run and complete the sign-in faster, or raise the Browserless plan session limit for a longer window.",
      });
      return;
    }

    const storageState = await context.storageState();
    await saveGmailSession(storageState);
    // A human-completed login clears the automated-login rate limit.
    await recordLoginSuccess();
    await resetLoginGate();

    const verified = await loadGmailSession();
    log.info("auth.saved", {
      cookieCount: storageState.cookies.length,
      originCount: storageState.origins.length,
      verifiedInNeon: Boolean(verified),
    });

    console.log("\n" + "=".repeat(78));
    console.log("  SESSION SAVED TO NEON");
    console.log("=".repeat(78));
    console.log("\n  Next: pnpm tsx scripts/verify-gmail-login.ts");
    console.log("  That reuses this session and exercises inbox discovery.\n");

    await context.close().catch(() => undefined);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

void run()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    log.error("auth.failed", { error: redact(error instanceof Error ? error.message : String(error)) });
    await closePool();
    process.exit(1);
  });
