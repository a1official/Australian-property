/** Microsoft identity OAuth and Graph token helpers for the Outlook connector. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { runtimeEnv } from "./runtime-env";

export const OUTLOOK_SCOPES = ["offline_access", "User.Read", "Mail.Read", "Mail.Send"];
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const STATE_TTL_MS = 10 * 60_000;

export type OutlookOAuthConfig = { clientId: string; clientSecret: string; tenantId: string; redirectUri: string };
export type FetchLike = typeof fetch;

export class OutlookOAuthError extends Error { readonly permanent = true; constructor(message: string) { super(message); this.name = "OutlookOAuthError"; } }
export class OutlookNeedsReauthorizationError extends OutlookOAuthError { readonly needsReauthorization = true; constructor(message: string) { super(message); this.name = "OutlookNeedsReauthorizationError"; } }

export function readOutlookOAuthConfig(env: NodeJS.ProcessEnv = process.env): OutlookOAuthConfig {
  const clientId = runtimeEnv("OUTLOOK_CLIENT_ID", env);
  const clientSecret = runtimeEnv("OUTLOOK_CLIENT_SECRET", env);
  const redirectUri = runtimeEnv("OUTLOOK_REDIRECT_URI", env);
  const tenantId = runtimeEnv("OUTLOOK_TENANT_ID", env) || "common";
  if (!clientId || !clientSecret || !redirectUri) throw new OutlookOAuthError("Outlook OAuth is not configured. Set OUTLOOK_CLIENT_ID, OUTLOOK_CLIENT_SECRET and OUTLOOK_REDIRECT_URI.");
  return { clientId, clientSecret, tenantId, redirectUri };
}
function authBase(config: OutlookOAuthConfig) { return `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0`; }
function sign(value: string, secret: string) { return createHmac("sha256", secret).update(value).digest("base64url"); }
export function createOutlookOAuthState(secret: string, now = Date.now()) {
  const nonce = randomBytes(16).toString("base64url"); const verifier = randomBytes(32).toString("base64url");
  const encoded = Buffer.from(JSON.stringify({ nonce, verifier, issuedAt: now }), "utf8").toString("base64url");
  return { cookieValue: `${encoded}.${sign(encoded, secret)}`, stateParam: nonce, verifier };
}
export function pkceChallenge(verifier: string) { return createHash("sha256").update(verifier).digest("base64url"); }
export function verifyOutlookOAuthState(cookieValue: string | undefined, stateParam: string | undefined, secret: string, now = Date.now()): { verifier: string } {
  if (!cookieValue || !stateParam) throw new OutlookOAuthError("The Outlook sign-in session expired. Start again.");
  const [encoded, signature] = cookieValue.split(".");
  const expected = Buffer.from(sign(encoded ?? "", secret)); const supplied = Buffer.from(signature ?? "");
  if (!encoded || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new OutlookOAuthError("The Outlook sign-in session failed verification. Start again.");
  let state: { nonce: string; verifier: string; issuedAt: number };
  try { state = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch { throw new OutlookOAuthError("The Outlook sign-in session is unreadable. Start again."); }
  if (state.nonce !== stateParam || !state.issuedAt || now - state.issuedAt > STATE_TTL_MS) throw new OutlookOAuthError("The Outlook sign-in request expired. Start again.");
  return { verifier: state.verifier };
}
export function buildOutlookAuthorizationUrl(config: OutlookOAuthConfig, state: string, verifier: string) {
  const params = new URLSearchParams({ client_id: config.clientId, response_type: "code", redirect_uri: config.redirectUri, response_mode: "query", scope: OUTLOOK_SCOPES.join(" "), state, code_challenge: pkceChallenge(verifier), code_challenge_method: "S256", prompt: "select_account" });
  return `${authBase(config)}/authorize?${params}`;
}
type TokenPayload = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string };
async function postToken(config: OutlookOAuthConfig, body: URLSearchParams, fetchImpl: FetchLike): Promise<TokenPayload> {
  const response = await fetchImpl(`${authBase(config)}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body, cache: "no-store", signal: AbortSignal.timeout(15_000) });
  const payload = await response.json().catch(() => null) as TokenPayload | null;
  if (!payload || !response.ok || payload.error) {
    if (payload?.error === "invalid_grant" || payload?.error === "invalid_client") throw new OutlookNeedsReauthorizationError("Microsoft reported that the Outlook authorization is no longer valid. Reconnect Outlook to continue.");
    throw new Error(`Microsoft token request failed (${response.status}).`);
  }
  return payload;
}
export async function exchangeOutlookCode(options: { code: string; verifier: string; config: OutlookOAuthConfig; fetchImpl?: FetchLike }) {
  const payload = await postToken(options.config, new URLSearchParams({ client_id: options.config.clientId, client_secret: options.config.clientSecret, code: options.code, redirect_uri: options.config.redirectUri, grant_type: "authorization_code", code_verifier: options.verifier }), options.fetchImpl ?? fetch);
  if (!payload.access_token) throw new Error("Microsoft did not return an access token.");
  return { accessToken: payload.access_token, refreshToken: payload.refresh_token ?? null, scopes: payload.scope ?? OUTLOOK_SCOPES.join(" ") };
}
export async function refreshOutlookAccessToken(options: { refreshToken: string; config: OutlookOAuthConfig; fetchImpl?: FetchLike }) {
  const payload = await postToken(options.config, new URLSearchParams({ client_id: options.config.clientId, client_secret: options.config.clientSecret, refresh_token: options.refreshToken, grant_type: "refresh_token", scope: OUTLOOK_SCOPES.join(" ") }), options.fetchImpl ?? fetch);
  if (!payload.access_token) throw new OutlookNeedsReauthorizationError("Microsoft did not return an access token on refresh.");
  return { accessToken: payload.access_token, refreshToken: payload.refresh_token ?? null };
}
export async function fetchOutlookProfile(accessToken: string, fetchImpl: FetchLike = fetch) {
  const response = await fetchImpl(`${GRAPH_BASE}/me?$select=mail,userPrincipalName`, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(15_000) });
  const payload = await response.json().catch(() => null) as { mail?: string; userPrincipalName?: string } | null;
  const email = payload?.mail || payload?.userPrincipalName;
  if (!response.ok || !email) throw new Error("Microsoft Graph did not return the connected mailbox address.");
  return email.toLowerCase();
}
export { GRAPH_BASE };
