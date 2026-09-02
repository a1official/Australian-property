#!/usr/bin/env tsx
/**
 * gmail-auth.ts
 *
 * TypeScript + Playwright script to authenticate Gmail using real local Chrome
 * and extract valid session tokens to `.local/gmail-session.json`.
 *
 * Usage:
 *   pnpm gmail:auth
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as nodePath from "node:path";
import * as nodeProcess from "node:process";
import { chromium, type BrowserContext, type Page } from "playwright";

const ROOT_DIR = nodePath.resolve(__dirname, "..", "..");
const LOCAL_DIR = nodePath.resolve(ROOT_DIR, ".local");
const PROFILE_DIR = nodePath.resolve(ROOT_DIR, ".browser-profiles", "gmail-chrome");

function parseEnvFile(filePath: string): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(filePath, "utf8")
        .split(/\r?\n/)
        .flatMap((line) => {
          const match = line.match(/^([^#][^=]*)=(.*)/);
          return match ? [[match[1].trim(), match[2].trim()]] : [];
        })
    );
  } catch {
    return {};
  }
}

const env = {
  ...parseEnvFile(nodePath.resolve(ROOT_DIR, ".env")),
  ...nodeProcess.env,
};

async function main() {
  const username = env.GMAIL_USERNAME;
  const password = env.GMAIL_PASSWORD;

  if (!username || !password) {
    console.error("[gmail-auth] GMAIL_USERNAME and GMAIL_PASSWORD must be set in .env");
    nodeProcess.exit(1);
  }

  console.log("=".repeat(60));
  console.log("  Gmail Auth — Local Chrome Session Generator (TypeScript)");
  console.log("=".repeat(60));
  console.log(`  Account: ${username}`);
  console.log(`  Profile: ${PROFILE_DIR}`);
  console.log("=".repeat(60) + "\n");

  mkdirSync(PROFILE_DIR, { recursive: true });
  mkdirSync(LOCAL_DIR, { recursive: true });

  console.log("[gmail-auth] Launching real Google Chrome...");
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: "chrome",
      headless: false,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-setuid-sandbox",
      ],
      viewport: { width: 1280, height: 900 },
      ignoreDefaultArgs: ["--enable-automation"],
    });
  } catch {
    console.log("[gmail-auth] Chrome channel not found, falling back to MsEdge...");
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: "msedge",
      headless: false,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
      ],
      viewport: { width: 1280, height: 900 },
      ignoreDefaultArgs: ["--enable-automation"],
    });
  }

  const page = context.pages()[0] || (await context.newPage());

  try {
    console.log("[gmail-auth] Navigating to Gmail...");
    await page.goto("https://mail.google.com/mail/u/0/#inbox", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(3000);

    let url = page.url();
    if (!url.includes("accounts.google.com") && url.includes("mail.google.com")) {
      console.log("[gmail-auth] Already logged in via persistent profile!");
    } else {
      console.log(`[gmail-auth] Navigating to sign-in for ${username}...`);
      await page.goto("https://accounts.google.com/signin/v2/identifier", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2000);

      // Check account chooser
      const accountChoice = page.locator(`[data-email="${username}"], div[data-identifier="${username}"]`).first();
      if (await accountChoice.isVisible({ timeout: 3000 }).catch(() => false)) {
        await accountChoice.click();
        await page.waitForTimeout(2000);
      }

      // Fill email
      const emailInput = page.locator('input[type="email"]').first();
      if (await emailInput.isVisible({ timeout: 5000 }).catch(() => false)) {
        await emailInput.fill(username);
        await page.keyboard.press("Enter");
        await page.waitForTimeout(3000);
      }

      // Fill password
      const passwordInput = page.locator('input[type="password"]').first();
      if (await passwordInput.isVisible({ timeout: 5000 }).catch(() => false)) {
        await passwordInput.fill(password);
        await page.keyboard.press("Enter");
        await page.waitForTimeout(5000);
      }

      // Wait for user or login to complete
      console.log("[gmail-auth] Waiting for Gmail inbox to load...");
      try {
        await page.waitForURL((u) => u.href.includes("mail.google.com") && !u.href.includes("accounts.google.com"), {
          timeout: 60_000,
        });
      } catch {
        console.log("[gmail-auth] Please complete any 2FA/verification in the opened Chrome browser window...");
        await page.waitForURL((u) => u.href.includes("mail.google.com") && !u.href.includes("accounts.google.com"), {
          timeout: 120_000,
        });
      }
    }

    // Extract & save session
    console.log("[gmail-auth] Saving storage state...");
    const state = await context.storageState();
    const sessionPath = nodePath.resolve(LOCAL_DIR, "gmail-session.json");
    writeFileSync(sessionPath, JSON.stringify(state, null, 2), { mode: 0o600 });

    console.log(`\n[gmail-auth] ✓ SUCCESS! Saved ${state.cookies.length} session cookies to:`);
    console.log(`            ${sessionPath}\n`);
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error("[gmail-auth] Error:", err);
  nodeProcess.exit(1);
});
