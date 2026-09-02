/**
 * Keeps ONE long-lived Browserless session alive across poll cycles.
 *
 * The previous design opened a fresh CDP connection, context and Gmail
 * navigation on every 60s cycle, plus a second connection to send each reply.
 * That is roughly 1,440 new browser sessions per day from a datacentre IP,
 * which is both wasteful and the strongest possible bot signal: a real user
 * keeps one browser open for days.
 *
 * This manager instead:
 *   - opens a session lazily, only when the mailbox actually needs checking;
 *   - reuses it across cycles and for reply delivery;
 *   - revalidates cheaply on an interval rather than on every use;
 *   - recycles proactively before Browserless times the connection out;
 *   - never reconnects in a tight loop after a failure.
 */

import type { BrowserContext } from "playwright-core";

import type { Logger } from "./logger";
import { NeedsReauthenticationError, openGmailSession, type GmailSession } from "./gmail-worker";

/**
 * Browserless enforces an absolute session deadline from browser start, set by
 * the plan: 2 minutes on Free, 15 on Prototyping, 30 on Starter, 60 on Scale.
 * Reconnecting cannot extend it. Recycling must therefore happen just inside
 * that deadline, or the session dies mid-operation instead of being replaced
 * cleanly. Configure BROWSERLESS_MAX_SESSION_MS to match the active plan.
 */
const PLAN_MAX_SESSION_MS = Number(process.env.BROWSERLESS_MAX_SESSION_MS || 120_000);

/** Recycle with a safety margin so a job never runs into the hard deadline. */
const MAX_SESSION_AGE_MS = Math.max(30_000, Math.floor(PLAN_MAX_SESSION_MS * 0.8));

/**
 * Revalidate at most once per session lifetime. On a short-lived plan the
 * session is recycled long before an idle probe would ever be useful.
 */
const REVALIDATE_AFTER_MS = Math.max(30_000, Math.floor(MAX_SESSION_AGE_MS / 2));

/** Minimum spacing between connection attempts after a failure. */
const RECONNECT_BACKOFF_MS = 5 * 60_000;

export type SessionManagerConfig = {
  wsEndpoint?: string;
  apiKey?: string;
  username: string;
  password: string;
  logger: Logger;
};

export class GmailSessionManager {
  private session: GmailSession | null = null;
  private openedAt = 0;
  private lastValidatedAt = 0;
  private lastFailureAt = 0;
  private reuseCount = 0;

  constructor(private readonly config: SessionManagerConfig) {}

  /** True when a live session is held, so the mailbox can be checked cheaply. */
  get isOpen(): boolean {
    return this.session !== null;
  }

  get stats(): { reuseCount: number; ageMs: number; open: boolean } {
    return {
      reuseCount: this.reuseCount,
      ageMs: this.session ? Date.now() - this.openedAt : 0,
      open: this.session !== null,
    };
  }

  /** Blocks a reconnect storm after a failed attempt. */
  /** Tracks failures explicitly rather than inferring from a zero timestamp. */
  private hasFailed = false;

  private inBackoff(): boolean {
    return this.hasFailed && Date.now() - this.lastFailureAt < RECONNECT_BACKOFF_MS;
  }

  private async discard(reason: string): Promise<void> {
    if (!this.session) return;
    this.config.logger.info("session.discarded", { reason, reuseCount: this.reuseCount });
    const closing = this.session;
    this.session = null;
    this.reuseCount = 0;
    await closing.close().catch(() => undefined);
  }

  /**
   * Returns a usable Gmail context, reusing the existing session when possible.
   * A reauthentication requirement propagates rather than being retried.
   */
  async acquire(): Promise<BrowserContext> {
    const now = Date.now();

    if (this.session) {
      if (now - this.openedAt > MAX_SESSION_AGE_MS) {
        await this.discard("max age reached");
      } else if (now - this.lastValidatedAt > REVALIDATE_AFTER_MS) {
        // Cheap liveness probe: confirm the context still has pages available
        // rather than re-navigating Gmail on every single cycle.
        const alive = await this.probe();
        if (!alive) await this.discard("failed liveness probe");
        else this.lastValidatedAt = now;
      }
    }

    if (this.session) {
      this.reuseCount += 1;
      this.config.logger.debug("session.reused", { reuseCount: this.reuseCount });
      return this.session.context;
    }

    if (this.inBackoff()) {
      const waitMs = RECONNECT_BACKOFF_MS - (now - this.lastFailureAt);
      throw new Error(`Gmail session reconnect is backing off for another ${Math.ceil(waitMs / 1000)}s.`);
    }

    try {
      this.config.logger.info("session.opening");
      this.session = await openGmailSession(this.config);
      this.openedAt = Date.now();
      this.lastValidatedAt = this.openedAt;
      this.lastFailureAt = 0;
      this.hasFailed = false;
      this.reuseCount = 0;
      return this.session.context;
    } catch (error) {
      this.lastFailureAt = Date.now();
      this.hasFailed = true;
      this.session = null;
      // A challenge needs a human; do not let the caller treat it as transient.
      if (error instanceof NeedsReauthenticationError) throw error;
      throw error;
    }
  }

  /** Lightweight check that the remote browser is still responsive. */
  private async probe(): Promise<boolean> {
    if (!this.session) return false;
    try {
      const page = await this.session.context.newPage();
      try {
        await page.goto("https://mail.google.com/mail/u/0/#inbox", {
          waitUntil: "domcontentloaded",
          timeout: 20_000,
        });
        const url = page.url();
        return url.startsWith("https://mail.google.com") && !url.includes("accounts.google.com");
      } finally {
        await page.close().catch(() => undefined);
      }
    } catch {
      return false;
    }
  }

  /** Marks the session unusable so the next acquire reconnects. */
  async invalidate(reason: string): Promise<void> {
    await this.discard(reason);
  }

  async close(): Promise<void> {
    await this.discard("worker shutdown");
  }
}
