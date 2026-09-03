import "server-only";

import { buildAuthorizationUrl, createOAuthState, readOAuthClientConfig } from "@/lib/gmail-oauth";
import { assertEncryptionKeyConfigured } from "@/lib/token-crypto";

export const runtime = "nodejs";
export const maxDuration = 15;

const STATE_COOKIE = "parcel_atlas_gmail_oauth";

/**
 * Begins Gmail OAuth consent.
 *
 * The signed state and the PKCE verifier are held in an HttpOnly cookie, so
 * neither is readable by client JavaScript and a forged callback cannot pass.
 */
export async function GET(request: Request) {
  try {
    const config = readOAuthClientConfig();
    // Refuse to start if the token could not be encrypted on return; otherwise
    // consent would succeed and then fail at the callback.
    assertEncryptionKeyConfigured();

    const { cookieValue, stateParam, verifier } = createOAuthState(config.clientSecret);
    const authorizationUrl = buildAuthorizationUrl(config, stateParam, verifier);
    const secure = new URL(request.url).protocol === "https:";

    return new Response(null, {
      status: 302,
      headers: {
        Location: authorizationUrl,
        "Cache-Control": "no-store",
        "Set-Cookie": [
          `${STATE_COOKIE}=${cookieValue}`,
          "Path=/api/gmail/oauth",
          "HttpOnly",
          "SameSite=Lax",
          ...(secure ? ["Secure"] : []),
          "Max-Age=600",
        ].join("; "),
      },
    });
  } catch (error) {
    // Never redirect to Google with a broken configuration.
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "Gmail sign-in could not be started." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
