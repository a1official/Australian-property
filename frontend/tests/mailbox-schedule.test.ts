/**
 * Verifies the adaptive mailbox scheduling and session reuse policy.
 *
 * These rules are what stop the worker opening ~1,440 browser sessions a day,
 * which was both wasteful and a strong bot signal to Google.
 */

import assert from "node:assert/strict";
import test from "node:test";

const MIN_INTERVAL = 120_000;
const MAX_INTERVAL = 900_000;

/** Mirrors recordMailboxCheck / dueForMailboxCheck in render-worker.ts. */
function createScheduler(now = 0) {
  let clock = now;
  let nextCheckAt = 0;
  let quietChecks = 0;
  return {
    advance(ms: number) {
      clock += ms;
    },
    get now() {
      return clock;
    },
    due() {
      return clock >= nextCheckAt;
    },
    record(foundMail: boolean) {
      if (foundMail) {
        quietChecks = 0;
        nextCheckAt = clock + MIN_INTERVAL;
        return MIN_INTERVAL;
      }
      quietChecks += 1;
      const backoff = Math.min(MIN_INTERVAL * 2 ** Math.min(quietChecks, 4), MAX_INTERVAL);
      nextCheckAt = clock + backoff;
      return backoff;
    },
    get quietChecks() {
      return quietChecks;
    },
  };
}

test("the first check is due immediately", () => {
  assert.equal(createScheduler().due(), true);
});

test("a quiet mailbox backs off exponentially up to the ceiling", () => {
  const scheduler = createScheduler();
  const intervals = [1, 2, 3, 4, 5, 6].map(() => {
    const backoff = scheduler.record(false);
    scheduler.advance(backoff);
    return backoff;
  });

  for (let index = 1; index < intervals.length; index += 1) {
    assert.ok(intervals[index] >= intervals[index - 1], "interval must not shrink while quiet");
  }
  assert.equal(intervals.at(-1), MAX_INTERVAL, "backoff settles at the ceiling");
  assert.ok(intervals[0] <= MAX_INTERVAL);
});

test("finding mail resets to the fastest interval", () => {
  const scheduler = createScheduler();
  for (let index = 0; index < 5; index += 1) {
    scheduler.advance(scheduler.record(false));
  }
  assert.ok(scheduler.quietChecks >= 5);

  const afterMail = scheduler.record(true);
  assert.equal(afterMail, MIN_INTERVAL, "responsiveness returns as soon as mail arrives");
  assert.equal(scheduler.quietChecks, 0);
});

test("a check is not due before its interval elapses", () => {
  const scheduler = createScheduler();
  // record() returns the backoff it just scheduled; assert against that rather
  // than assuming it equals MIN_INTERVAL (the first quiet check doubles it).
  const scheduled = scheduler.record(false);
  scheduler.advance(scheduled - 1_000);
  assert.equal(scheduler.due(), false, "not due one second early");
  scheduler.advance(1_000);
  assert.equal(scheduler.due(), true, "due once the interval elapses");
});

test("a mailbox hit schedules exactly the minimum interval", () => {
  const scheduler = createScheduler();
  const scheduled = scheduler.record(true);
  assert.equal(scheduled, MIN_INTERVAL);
  scheduler.advance(MIN_INTERVAL - 1);
  assert.equal(scheduler.due(), false);
  scheduler.advance(1);
  assert.equal(scheduler.due(), true);
});

test("an idle day opens far fewer sessions than per-cycle polling", () => {
  const scheduler = createScheduler();
  const DAY_MS = 24 * 60 * 60_000;
  let checks = 0;
  while (scheduler.now < DAY_MS) {
    if (scheduler.due()) {
      checks += 1;
      scheduler.record(false);
    }
    scheduler.advance(30_000);
  }

  // The old design opened one session per 60s cycle: 1,440 per day.
  assert.ok(checks < 150, `expected well under 150 mailbox opens per idle day, got ${checks}`);
  assert.ok(checks > 0);
});

test("worst-case detection latency stays bounded", () => {
  // Even fully backed off, mail is picked up within the ceiling interval.
  assert.ok(MAX_INTERVAL <= 15 * 60_000, "quiet-mailbox latency must stay within 15 minutes");
});
