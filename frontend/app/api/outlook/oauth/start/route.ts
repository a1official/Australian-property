import "server-only";
import { buildOutlookAuthorizationUrl, createOutlookOAuthState, readOutlookOAuthConfig } from "@/lib/outlook-oauth";
import { assertEncryptionKeyConfigured } from "@/lib/token-crypto";
import { initSchema } from "@/lib/db";
export const runtime = "nodejs";
const COOKIE = "parcel_atlas_outlook_oauth";
export async function GET(request: Request) {
  try {
    const config = readOutlookOAuthConfig(); assertEncryptionKeyConfigured(); await initSchema();
    const state = createOutlookOAuthState(config.clientSecret);
    const secure = new URL(request.url).protocol === "https:";
    return new Response(null, { status: 302, headers: { Location: buildOutlookAuthorizationUrl(config, state.stateParam, state.verifier), "Cache-Control": "no-store", "Set-Cookie": [`${COOKIE}=${state.cookieValue}`, "Path=/api/outlook/oauth", "HttpOnly", "SameSite=Lax", ...(secure ? ["Secure"] : []), "Max-Age=600"].join("; ") } });
  } catch (error) { return Response.json({ ok: false, error: error instanceof Error ? error.message : "Outlook sign-in could not be started." }, { status: 503 }); }
}
