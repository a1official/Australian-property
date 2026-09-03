import "server-only";

import { createHash } from "node:crypto";

import { saveGmailConnection } from "@/lib/db";
import {
  exchangeCodeForTokens,
  fetchProfileEmail,
  readOAuthClientConfig,
  verifyOAuthState,
} from "@/lib/gmail-oauth";
import { createLogger } from "@/lib/logger";
import { encryptSecret, maskEmail } from "@/lib/token-crypto";

export const runtime = "nodejs";
export const maxDuration = 30;

const STATE_COOKIE = "parcel_atlas_gmail_oauth";
const log = createLogger({ route: "gmail/oauth/callback" });

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

/** Redirects home with only a short, safe status code in the fragment. */
function redirectHome(request: Request, status: string): Response {
  const target = new URL("/", request.url);
  target.hash = `batch-reports&gmail=${encodeURIComponent(status)}`;
  return new Response(null, {
    status: 302,
    headers: {
      Location: target.toString(),
      "Cache-Control": "no-store",
      // Consume the one-time state cookie either way.
      "Set-Cookie": `${STATE_COOKIE}=; Path=/api/gmail/oauth; HttpOnly; SameSite=Lax; Max-Age=0`,
    },
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  const providerError = url.searchParams.get("error");

  // Google's error text is not forwarded; only a fixed status code is.
  if (providerError) {
    log.warn("oauth.provider_declined", { providerError });
    return redirectHome(request, "declined");
  }
  if (!code) return redirectHome(request, "missing_code");

  try {
    const config = readOAuthClientConfig();
    // Validate state once and take the PKCE verifier from the same payload.
    const state = verifyOAuthState(readCookie(request, STATE_COOKIE), stateParam ?? undefined, config.clientSecret);

    const tokens = await exchangeCodeForTokens({ code, verifier: state.verifier, config });
    const email = await fetchProfileEmail(tokens.accessToken);

    await saveGmailConnection({
      emailMasked: maskEmail(email),
      emailHash: createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 32),
      // Null when Google omits it for an already-authorized account; the store
      // keeps the existing token rather than nulling a working grant.
      refreshTokenEncrypted: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
      scopes: tokens.scope,
    });

    // Counts and flags only: no token material, no full address.
    log.info("oauth.connected", { hasRefreshToken: Boolean(tokens.refreshToken), scopeCount: tokens.scope.split(" ").length });
    return redirectHome(request, "connected");
  } catch (error) {
    log.error("oauth.callback_failed", { error: error instanceof Error ? error.message : "unknown" });
    return redirectHome(request, "failed");
  }
}
