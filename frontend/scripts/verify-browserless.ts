#!/usr/bin/env tsx
/**
 * Diagnoses the Browserless + Playwright path without risking the bot account.
 *
 * Deliberately does NOT attempt a password login: repeated automated login
 * failures are what trigger Google account locks. This checks, in order:
 *   1. Browserless CDP connectivity and quota
 *   2. whether a Gmail session is stored in Neon
 *   3. whether that stored session still authenticates to Gmail
 *   4. whether the inbox search + attachment DOM selectors still resolve
 *
 *   pnpm tsx scripts/verify-browserless.ts
 */

import { chromium } from "playwright-core";

import { closePool, loadGmailSession } from "../lib/db";
import { buildBrowserlessEndpoint, isChallengeUrl } from "../lib/gmail-worker";
import { createLogger, redact } from "../lib/logger";

const log = createLogger({ script: "verify-browserless" });

function env(key: string): string {
  return process.env[key]?.trim() || "";
}

async function run(): Promise<void> {
  // --- 1. Endpoint configuration -------------------------------------------
  let endpoint: string;
  try {
    endpoint = buildBrowserlessEndpoint({
      wsEndpoint: env("BROWSERLESS_WS_ENDPOINT"),
      apiKey: env("BROWSERLESS_API_KEY"),
    });
  } catch (error) {
    log.error("step1.endpoint_missing", { error: error instanceof Error ? error.message : String(error) });
    return;
  }
  log.info("step1.endpoint_built", { endpoint: redact(endpoint) });

  // --- 2. CDP connectivity --------------------------------------------------
  let browser;
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: 45_000 });
    log.info("step2.connected", { version: browser.version() });
  } catch (error) {
    log.error("step2.connect_failed", {
      error: redact(error instanceof Error ? error.message : String(error)),
      hint: "Check the Browserless token, plan quota, and that the region host is correct.",
    });
    return;
  }

  try {
    // --- 3. Neutral page load: proves the remote browser actually renders ---
    const probe = await browser.newContext();
    const probePage = await probe.newPage();
    try {
      await probePage.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 30_000 });
      log.info("step3.render_ok", { title: await probePage.title() });
    } catch (error) {
      log.error("step3.render_failed", { error: redact(error instanceof Error ? error.message : String(error)) });
      return;
    } finally {
      await probe.close().catch(() => undefined);
    }

    // --- 4. Stored Gmail session -------------------------------------------
    const stored = (await loadGmailSession()) as { cookies?: unknown[] } | null;
    if (!stored) {
      log.warn("step4.no_stored_session", {
        impact: "The worker would attempt a password login, which Google usually challenges on a datacentre IP.",
        fix: "Run: pnpm tsx scripts/seed-gmail-session.ts (after a local pnpm gmail:auth)",
      });
      return;
    }
    log.info("step4.session_found", { cookieCount: Array.isArray(stored.cookies) ? stored.cookies.length : 0 });

    // --- 5. Does the stored session still authenticate? --------------------
    const context = await browser.newContext({
      storageState: stored as never,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
      timezoneId: "Australia/Sydney",
    });
    const page = await context.newPage();
    try {
      await page.goto("https://mail.google.com/mail/u/0/#inbox", { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(4_000);
      const url = page.url();

      if (isChallengeUrl(url)) {
        log.error("step5.challenge", {
          url: redact(url),
          verdict: "Google is challenging this session. A job would be parked as needs_reauthentication.",
        });
        return;
      }
      const authenticated = url.startsWith("https://mail.google.com") && !url.includes("accounts.google.com");
      log.info("step5.session_check", { authenticated, url: redact(url) });
      if (!authenticated) {
        // Distinguish genuine expiry from a trust rejection: they need
        // different fixes, and conflating them sends you down the wrong path.
        const cookies = await context.cookies();
        const nowSeconds = Date.now() / 1000;
        const core = cookies.filter((cookie) => ["SID", "HSID", "SSID", "LSID", "__Secure-1PSID"].includes(cookie.name));
        const expired = core.filter((cookie) => cookie.expires > 0 && cookie.expires < nowSeconds);
        const rejectedToChooser = url.includes("accountchooser") || url.includes("ServiceLogin");

        if (core.length && expired.length === 0 && rejectedToChooser) {
          log.error("step5.session_rejected_not_expired", {
            coreCookies: core.length,
            expiredCookies: 0,
            verdict:
              "Cookies are still valid but Google declined them from this IP. This is a device/location trust decision, not expiry.",
            fix: "Prefer Gmail API OAuth for unattended runs; browser cookies minted on a home IP are often refused from a datacentre IP.",
          });
        } else {
          log.error("step5.session_expired", {
            coreCookies: core.length,
            expiredCookies: expired.length,
            fix: "Re-run pnpm gmail:auth locally, then re-seed the session.",
          });
        }
        return;
      }

      // --- 6. Do the inbox selectors still resolve? -----------------------
      const searchInput = page.locator('input[name="q"], input[aria-label*="Search"]').first();
      const searchVisible = await searchInput.isVisible({ timeout: 8_000 }).catch(() => false);
      if (searchVisible) {
        await searchInput.click();
        await searchInput.fill("has:attachment filename:csv -from:me");
        await page.keyboard.press("Enter");
        await page.waitForTimeout(4_000);
      }
      const threadCount = await page.locator('div[role="main"] tr.zA').count();
      log.info("step6.inbox_search", { searchVisible, threadCount });

      // --- 7. Attachment discovery on the first matching thread ------------
      if (threadCount > 0) {
        await page.locator('div[role="main"] tr.zA').first().click();
        await page.waitForTimeout(3_500);
        const subjectVisible = await page.locator("h2.hP").first().isVisible({ timeout: 5_000 }).catch(() => false);
        const senderNode = page.locator("span[email], span[data-hovercard-id]").first();
        const senderFound = await senderNode.isVisible({ timeout: 3_000 }).catch(() => false);
        const downloadNodes = await page.locator("[download_url]").count();
        let csvAttachmentFound = false;
        for (let index = 0; index < downloadNodes; index += 1) {
          const raw = (await page.locator("[download_url]").nth(index).getAttribute("download_url")) ?? "";
          if (raw.toLowerCase().includes(".csv")) { csvAttachmentFound = true; break; }
        }
        log.info("step7.thread_parse", { subjectVisible, senderFound, downloadNodes, csvAttachmentFound });
      }

      log.info("verdict", { browserless: "ok", gmailSession: "valid", pipeline: "reachable" });
    } finally {
      await page.close().catch(() => undefined);
      await context.close().catch(() => undefined);
    }
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
    log.error("diagnostic.failed", { error: redact(error instanceof Error ? error.message : String(error)) });
    await closePool();
    process.exit(1);
  });
