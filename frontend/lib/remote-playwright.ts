import "server-only";

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import {
  computeCheckpointKey,
  isMessageCompleted,
  registerInboundCheckpoint,
  markCheckpointSent,
  updateCheckpointReports,
} from "@/lib/checkpoints";

export type RemoteInboundCsv = {
  key: string;
  sender: string;
  subject: string;
  fileName: string;
  csvContent: string;
  skipped: boolean;
};

export type RemotePlaywrightConfig = {
  wsEndpoint?: string;
  apiKey?: string;
  query?: string;
  maxEmails?: number;
  timeoutMs?: number;
  force?: boolean;
};

function parseEnvironment(content: string): Record<string, string> {
  return Object.fromEntries(
    content.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^([^#][^=]*)=(.*)$/);
      return match ? [[match[1].trim(), match[2].trim()]] : [];
    })
  );
}

async function getSettings() {
  let fallback: Record<string, string> = {};
  try {
    fallback = parseEnvironment(await readFile(resolve(process.cwd(), "..", ".env"), "utf8"));
  } catch {
    // fallback file may not exist in production
  }

  const apiKey = process.env.BROWSERLESS_API_KEY || fallback.BROWSERLESS_API_KEY || "";
  const rawWs = process.env.BROWSERLESS_WS_ENDPOINT || fallback.BROWSERLESS_WS_ENDPOINT || "";
  let wsEndpoint = rawWs || (apiKey ? `wss://production-sfo.browserless.io?token=${apiKey}` : "");

  if (wsEndpoint && !wsEndpoint.includes("stealth=true")) {
    const separator = wsEndpoint.includes("?") ? "&" : "?";
    wsEndpoint = `${wsEndpoint}${separator}stealth=true&--disable-blink-features=AutomationControlled`;
  }

  return { apiKey, wsEndpoint };
}

async function loadSavedStorageState(): Promise<object | undefined> {
  const sessionPath = resolve(process.cwd(), "..", ".local", "gmail-session.json");
  try {
    const raw = await readFile(sessionPath, "utf8");
    return JSON.parse(raw) as object;
  } catch {
    return undefined;
  }
}

/**
 * Connects to a remote Chrome browser over CDP (WebSocket) and crawls Gmail for CSV review requests.
 */
export async function crawlGmailViaRemotePlaywright(
  options: RemotePlaywrightConfig = {}
): Promise<{
  endpoint: string;
  foundThreads: number;
  items: RemoteInboundCsv[];
}> {
  const config = await getSettings();
  const endpoint = options.wsEndpoint || config.wsEndpoint;

  if (!endpoint) {
    throw new Error(
      "Remote browser endpoint is not configured. Set BROWSERLESS_WS_ENDPOINT or BROWSERLESS_API_KEY in your environment variables."
    );
  }

  const query = options.query || "has:attachment filename:csv";
  const maxEmails = options.maxEmails || 5;
  const timeoutMs = options.timeoutMs || 45000;
  const force = Boolean(options.force);

  console.log(`[remote-playwright] Connecting over CDP to: ${endpoint.replace(/token=[^&]+/, "token=***")}`);
  const browser = await chromium.connectOverCDP(endpoint);

  const storageState = await loadSavedStorageState();
  const context: BrowserContext = await browser.newContext({
    ...(storageState ? { storageState: storageState as any } : {}),
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });

  const page: Page = await context.newPage();
  const items: RemoteInboundCsv[] = [];

  try {
    console.log("[remote-playwright] Navigating to Gmail inbox...");
    await page.goto("https://mail.google.com/mail/u/0/#inbox", {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    await page.waitForTimeout(3000);

    // Search query in Gmail
    const searchInput = page.locator('input[name="q"], input[aria-label*="Search"]').first();
    if (await searchInput.isVisible()) {
      console.log(`[remote-playwright] Performing search: ${query}`);
      await searchInput.click();
      await searchInput.fill(query);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(4000);
    }

    const emailRows = await page.locator('div[role="main"] tr.zA, div[role="main"] tr[role="row"]').all();
    console.log(`[remote-playwright] Found ${emailRows.length} matching thread(s).`);

    for (let index = 0; index < Math.min(emailRows.length, maxEmails); index += 1) {
      try {
        const row = emailRows[index];
        const subjSpan = row.locator('span[data-thread-id], span.bog, div.y6, span.bqe').first();
        if (await subjSpan.isVisible()) {
          await subjSpan.click();
        } else {
          await row.click();
        }
        await page.waitForTimeout(3000);

        // Scroll to reveal attachments
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1500);

        const subjectEl = page.locator('h2[data-thread-perm-id], h2.hP').first();
        const subject = (await subjectEl.isVisible()) ? (await subjectEl.innerText()).trim() : "Property Review Request";

        const senderEl = page.locator('span[email], span.gD, span.zF').first();
        const sender = (await senderEl.isVisible())
          ? (await senderEl.getAttribute("email")) || (await senderEl.innerText()).trim()
          : "";

        const cleanSender = sender.trim().toLowerCase();

        // Extract attachment
        const attachmentNodes = await page.locator('[download_url], span.aV3, div.a6S').all();
        let csvContent = "";
        let fileName = "property-batch.csv";

        for (const node of attachmentNodes) {
          const rawUrl = (await node.getAttribute("download_url")) || "";
          const text = (await node.innerText()).trim();

          if ((rawUrl + text).toLowerCase().includes(".csv")) {
            if (rawUrl && rawUrl.includes(":")) {
              const parts = rawUrl.split(":");
              if (parts.length >= 3) {
                fileName = parts[1] || fileName;
                const directUrl = parts.slice(2).join(":");
                console.log(`[remote-playwright] Fetching attachment: ${fileName}`);
                const response = await context.request.get(directUrl);
                if (response.ok()) {
                  const bodyBuffer = await response.body();
                  csvContent = bodyBuffer.toString("utf8");
                  break;
                }
              }
            }
          }
        }

        if (!csvContent) {
          console.log(`[remote-playwright] No readable CSV in thread ${index + 1}, returning.`);
          await page.goBack();
          await page.waitForTimeout(2000);
          continue;
        }

        // Checkpoint inspection
        const key = computeCheckpointKey(cleanSender, subject, fileName, csvContent);
        const alreadyDone = await isMessageCompleted(key);

        if (alreadyDone && !force) {
          console.log(`[checkpoint] Skipping already completed message: ${fileName} from ${cleanSender}`);
          items.push({ key, sender: cleanSender, subject, fileName, csvContent, skipped: true });
        } else {
          await registerInboundCheckpoint(key, cleanSender, subject, fileName, csvContent);
          items.push({ key, sender: cleanSender, subject, fileName, csvContent, skipped: false });
        }

        await page.goBack();
        await page.waitForTimeout(2000);
      } catch (rowErr) {
        console.error(`[remote-playwright] Error inspecting thread ${index + 1}:`, rowErr);
      }
    }

    return {
      endpoint: endpoint.replace(/token=[^&]+/, "token=***"),
      foundThreads: emailRows.length,
      items,
    };
  } finally {
    await browser.close();
  }
}
