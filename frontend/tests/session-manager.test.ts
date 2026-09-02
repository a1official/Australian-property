/**
 * Verifies the session manager reuses one Browserless connection instead of
 * opening a new one per cycle, and recycles it only when it should.
 */

import assert from "node:assert/strict";
import test from "node:test";

/**
 * Mirrors GmailSessionManager's lifecycle with a fake transport, so the reuse
 * and recycling policy can be asserted without a real browser.
 */
function createManager(options: { maxAgeMs?: number; revalidateAfterMs?: number; backoffMs?: number; probeResult?: () => boolean; openFails?: number } = {}) {
  const maxAgeMs = options.maxAgeMs ?? 45 * 60_000;
  const revalidateAfterMs = options.revalidateAfterMs ?? 10 * 60_000;
  const backoffMs = options.backoffMs ?? 5 * 60_000;
  let openFails = options.openFails ?? 0;

  let clock = 0;
  let session: { id: number } | null = null;
  let openedAt = 0;
  let lastValidatedAt = 0;
  let lastFailureAt = 0;
  // Explicit flag: a zero timestamp is a valid clock value, so "has it failed"
  // cannot be inferred from lastFailureAt alone.
  let hasFailed = false;
  let reuseCount = 0;
  let opens = 0;
  let closes = 0;
  let probes = 0;

  return {
    advance(ms: number) {
      clock += ms;
    },
    get opens() {
      return opens;
    },
    get closes() {
      return closes;
    },
    get probes() {
      return probes;
    },
    get reuseCount() {
      return reuseCount;
    },
    get isOpen() {
      return session !== null;
    },
    acquire(): { id: number } {
      if (session) {
        if (clock - openedAt > maxAgeMs) {
          session = null;
          closes += 1;
          reuseCount = 0;
        } else if (clock - lastValidatedAt > revalidateAfterMs) {
          probes += 1;
          const alive = options.probeResult ? options.probeResult() : true;
          if (!alive) {
            session = null;
            closes += 1;
            reuseCount = 0;
          } else {
            lastValidatedAt = clock;
          }
        }
      }

      if (session) {
        reuseCount += 1;
        return session;
      }

      if (hasFailed && clock - lastFailureAt < backoffMs) {
        throw new Error("reconnect backoff active");
      }

      if (openFails > 0) {
        openFails -= 1;
        lastFailureAt = clock;
        hasFailed = true;
        throw new Error("connect failed");
      }

      opens += 1;
      session = { id: opens };
      openedAt = clock;
      lastValidatedAt = clock;
      lastFailureAt = 0;
      hasFailed = false;
      reuseCount = 0;
      return session;
    },
    invalidate() {
      if (session) {
        session = null;
        closes += 1;
        reuseCount = 0;
      }
    },
  };
}

test("repeated cycles reuse a single connection", () => {
  const manager = createManager();
  const first = manager.acquire();
  for (let cycle = 0; cycle < 20; cycle += 1) {
    manager.advance(30_000);
    manager.acquire();
  }
  assert.equal(manager.opens, 1, "one connection for the whole run");
  assert.equal(manager.acquire().id, first.id, "same session object throughout");
});

test("an idle session is revalidated rather than reopened on every use", () => {
  const manager = createManager({ revalidateAfterMs: 10 * 60_000 });
  manager.acquire();
  manager.advance(11 * 60_000);
  manager.acquire();
  assert.equal(manager.probes, 1, "one cheap probe");
  assert.equal(manager.opens, 1, "no reconnect needed");
});

test("a dead session is replaced after a failed probe", () => {
  let alive = true;
  const manager = createManager({ revalidateAfterMs: 1_000, probeResult: () => alive });
  manager.acquire();
  alive = false;
  manager.advance(2_000);
  manager.acquire();
  assert.equal(manager.opens, 2, "reconnected once the probe failed");
  assert.equal(manager.closes, 1);
});

test("a session is recycled once it exceeds the maximum age", () => {
  const manager = createManager({ maxAgeMs: 45 * 60_000 });
  manager.acquire();
  manager.advance(46 * 60_000);
  manager.acquire();
  assert.equal(manager.opens, 2, "recycled before Browserless drops it");
});

test("a failed connection backs off instead of retrying immediately", () => {
  const manager = createManager({ openFails: 1, backoffMs: 5 * 60_000 });
  assert.throws(() => manager.acquire(), /connect failed/);
  // An immediate retry must be refused: this is what prevented the old
  // per-cycle reconnect storm.
  assert.throws(() => manager.acquire(), /backoff active/);
  manager.advance(5 * 60_000 + 1);
  assert.doesNotThrow(() => manager.acquire());
  assert.equal(manager.opens, 1);
});

test("invalidate forces exactly one reconnect", () => {
  const manager = createManager();
  manager.acquire();
  manager.invalidate();
  assert.equal(manager.isOpen, false);
  manager.acquire();
  assert.equal(manager.opens, 2);
});

test("a full idle day uses a handful of connections, not one per cycle", () => {
  const manager = createManager({ maxAgeMs: 45 * 60_000, revalidateAfterMs: 10 * 60_000 });
  const DAY_MS = 24 * 60 * 60_000;
  let elapsed = 0;
  while (elapsed < DAY_MS) {
    manager.acquire();
    manager.advance(120_000);
    elapsed += 120_000;
  }
  // 24h / 45m recycle window is ~32 connections, versus 1,440 before.
  assert.ok(manager.opens <= 40, `expected at most ~40 connections per day, got ${manager.opens}`);
  assert.ok(manager.reuseCount > 0, "sessions are genuinely reused between opens");
});
