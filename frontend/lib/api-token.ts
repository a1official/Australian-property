/**
 * Token and session-cookie primitives for the job control endpoints.
 *
 * Deliberately free of `server-only` so it can be unit tested with plain Node.
 * The Next-only wrapper lives in lib/api-auth.ts.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "parcel_atlas_admin";

export class UnauthorizedError extends Error {
  readonly status = 401;
  constructor(message = "Missing or invalid job API credentials.") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time compare of equal-length digests, so lengths cannot leak. */
function digestsMatch(left: string, right: string): boolean {
  return timingSafeEqual(digest(left), digest(right));
}

export function jobApiConfigured(): boolean {
  return Boolean(process.env.JOB_API_TOKEN?.trim());
}

export function verifyToken(provided: string): boolean {
  const expected = process.env.JOB_API_TOKEN?.trim();
  if (!expected || !provided) return false;
  return digestsMatch(provided, expected);
}

/**
 * Session cookie value: a hash derived from the token. Presenting it proves the
 * operator authenticated, without shipping the token itself to the browser.
 */
export function sessionCookieValue(): string {
  const expected = process.env.JOB_API_TOKEN?.trim();
  if (!expected) throw new UnauthorizedError("JOB_API_TOKEN is not configured on the server.");
  return createHash("sha256").update(`parcel-atlas-session:${expected}`, "utf8").digest("hex");
}

export function readCookie(cookieHeader: string, name: string): string {
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

/** Throws UnauthorizedError unless the request carries the token or a session. */
export function assertJobApiRequest(request: Request): void {
  const expected = process.env.JOB_API_TOKEN?.trim();
  if (!expected) {
    // Fail closed: an unset token must not mean "open to everyone".
    throw new UnauthorizedError("JOB_API_TOKEN is not configured on the server.");
  }

  const header = request.headers.get("authorization") || "";
  const bearer = header.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const provided = bearer || request.headers.get("x-job-api-token")?.trim() || "";
  if (provided && digestsMatch(provided, expected)) return;

  const cookie = readCookie(request.headers.get("cookie") || "", SESSION_COOKIE);
  if (cookie && digestsMatch(cookie, sessionCookieValue())) return;

  throw new UnauthorizedError();
}

export function unauthorizedResponse(error: unknown): Response {
  const status = error instanceof UnauthorizedError ? error.status : 500;
  return Response.json(
    { ok: false, error: error instanceof Error ? error.message : "Request could not be authorised." },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
