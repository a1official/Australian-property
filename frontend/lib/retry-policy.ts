/**
 * Bounded retry classification shared by the worker's Cotality, Browserless and
 * Gmail stages.
 *
 * Permanent failures (CSV validation, entitlement, unmatched address) must never
 * consume retry budget. Transient failures use capped exponential backoff with
 * deterministic jitter bounds so a stuck job cannot hot-loop.
 */

export type FailureClass = "retryable" | "permanent" | "needs_reauthentication";

export const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 15 * 60_000;

const REAUTH_PATTERNS = [
  /needs?[_ ]?reauth/i,
  /\b2fa\b/i,
  /two[- ]factor/i,
  /captcha/i,
  /security challenge/i,
  /verify (?:it'?s )?you/i,
  /signin\/v2\/challenge/i,
  /account (?:disabled|locked)/i,
  // Login rate limiting and credential rejection must stop the worker rather
  // than be retried: repeated automated attempts are what lock an account.
  /consecutive failed login attempts/i,
  /automatic login is disabled/i,
  /login cooldown active/i,
  /rejected the stored gmail_password/i,
  /did not present a password field/i,
  /manual sign-?in is required/i,
];

const PERMANENT_PATTERNS = [
  /csvvalidationerror/i,
  /requires? (?:an? )?address.*column/i,
  /not an accepted csv/i,
  /is not an accepted csv type/i,
  /exceeds \d+ characters/i,
  /maximum supported per email/i,
  /the limit is \d+ bytes/i,
  /does not contain any property addresses/i,
  /not an approved sender/i,
  /invalid corelogic property identifier/i,
  /\b(400|401|403|404)\b/,
];

const RETRYABLE_PATTERNS = [
  /\b(408|425|429|500|502|503|504)\b/,
  /rate ?limit/i,
  /too many requests/i,
  /timeout|timed out|etimedout/i,
  /econnreset|econnrefused|enotfound|eai_again|socket hang up/i,
  /temporarily unavailable|could not be reached/i,
  /backend_?error|internal error/i,
];

export function classifyFailure(error: unknown): FailureClass {
  if (error && typeof error === "object" && (error as { permanent?: unknown }).permanent === true) {
    return "permanent";
  }
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? "");
  if (REAUTH_PATTERNS.some((pattern) => pattern.test(message))) return "needs_reauthentication";
  if (PERMANENT_PATTERNS.some((pattern) => pattern.test(message))) return "permanent";
  if (RETRYABLE_PATTERNS.some((pattern) => pattern.test(message))) return "retryable";
  // Unknown failures get a bounded number of retries rather than being
  // discarded, but MAX_ATTEMPTS still stops them from looping forever.
  return "retryable";
}

export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const exponential = Math.min(BASE_DELAY_MS * 2 ** (safeAttempt - 1), MAX_DELAY_MS);
  // Full jitter in the upper half keeps a minimum spacing while spreading load.
  return Math.round(exponential / 2 + random() * (exponential / 2));
}

export function shouldRetry(failure: FailureClass, attempts: number): boolean {
  return failure === "retryable" && attempts < MAX_ATTEMPTS;
}

export function nextRunAt(attempt: number, now: Date = new Date(), random: () => number = Math.random): Date {
  return new Date(now.getTime() + backoffDelayMs(attempt, random));
}
