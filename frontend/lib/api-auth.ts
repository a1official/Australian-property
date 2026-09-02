import "server-only";

/**
 * Server-only re-export of the job API auth primitives.
 *
 * The implementation lives in lib/api-token.ts so it can be unit tested with
 * plain Node; this module adds the Next.js server-only guard for route handlers.
 */

export {
  SESSION_COOKIE,
  UnauthorizedError,
  assertJobApiRequest,
  jobApiConfigured,
  sessionCookieValue,
  unauthorizedResponse,
  verifyToken,
} from "./api-token";
