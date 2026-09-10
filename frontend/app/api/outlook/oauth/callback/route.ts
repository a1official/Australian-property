import "server-only";
import { createHash } from "node:crypto";
import { initSchema, saveOutlookConnection } from "@/lib/db";
import { exchangeOutlookCode, fetchOutlookProfile, readOutlookOAuthConfig, verifyOutlookOAuthState } from "@/lib/outlook-oauth";
import { encryptSecret, maskEmail } from "@/lib/token-crypto";
export const runtime = "nodejs";
const COOKIE = "parcel_atlas_outlook_oauth";
function cookie(request: Request) { for (const part of (request.headers.get("cookie") ?? "").split(";")) { const [key, ...rest] = part.trim().split("="); if (key === COOKIE) return rest.join("="); } return undefined; }
function finish(request: Request, status: string) { const target = new URL("/", request.url); target.hash = `batch-reports&outlook=${encodeURIComponent(status)}`; return new Response(null, { status: 302, headers: { Location: target.toString(), "Cache-Control": "no-store", "Set-Cookie": `${COOKIE}=; Path=/api/outlook/oauth; HttpOnly; SameSite=Lax; Max-Age=0` } }); }
export async function GET(request: Request) {
  const url = new URL(request.url); const code = url.searchParams.get("code");
  if (url.searchParams.get("error") || !code) return finish(request, "failed");
  try {
    await initSchema(); const config = readOutlookOAuthConfig(); const state = verifyOutlookOAuthState(cookie(request), url.searchParams.get("state") ?? undefined, config.clientSecret);
    const tokens = await exchangeOutlookCode({ code, verifier: state.verifier, config }); const email = await fetchOutlookProfile(tokens.accessToken);
    await saveOutlookConnection({ emailMasked: maskEmail(email), emailHash: createHash("sha256").update(email).digest("hex").slice(0, 32), refreshTokenEncrypted: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null, scopes: tokens.scopes });
    return finish(request, "connected");
  } catch { return finish(request, "failed"); }
}
