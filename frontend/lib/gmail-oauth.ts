/**
 * Gmail OAuth 2.0 and Gmail API access.
 *
 * Uses plain fetch rather than the Google SDK: the surface needed here is small,
 * and it keeps the worker dependency-light. Network and persistence are behind
 * injectable interfaces so the OAuth logic is testable without Google or Neon.
 *
 * No refresh token, access token, or client secret may leave this module toward
 * the browser or the logs.
 */

import { createHash, randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { runtimeEnv } from "./runtime-env";

export const GMAIL_SCOPES = [
  // Read message/attachment content and mark a processed message handled.
  "https://www.googleapis.com/auth/gmail.modify",
  // Send the report reply.
  "https://www.googleapis.com/auth/gmail.send",
];

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
export const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export type OAuthClientConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

/** The stored grant is unusable and a human must reconnect. */
export class NeedsReauthorizationError extends Error {
  readonly needsReauthorization = true;
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = "NeedsReauthorizationError";
  }
}

export class OAuthConfigError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = "OAuthConfigError";
  }
}

export function readOAuthClientConfig(env: NodeJS.ProcessEnv = process.env): OAuthClientConfig {
  const clientId = runtimeEnv("GMAIL_CLIENT_ID", env);
  const clientSecret = runtimeEnv("GMAIL_CLIENT_SECRET", env);
  const redirectUri = runtimeEnv("GMAIL_REDIRECT_URI", env);
  if (!clientId || !clientSecret || !redirectUri) {
    throw new OAuthConfigError(
      "Gmail OAuth is not configured. Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_REDIRECT_URI.",
    );
  }
  return { clientId, clientSecret, redirectUri };
}

// ---------------------------------------------------------------------------
// State and PKCE
// ---------------------------------------------------------------------------

export type OAuthStatePayload = { nonce: string; verifier: string; issuedAt: number };

const STATE_TTL_MS = 10 * 60_000;

/** Signs state with the client secret so a forged callback cannot pass. */
function signState(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function createOAuthState(secret: string, now = Date.now()): { cookieValue: string; stateParam: string; verifier: string } {
  const nonce = randomBytes(16).toString("base64url");
  // PKCE: the verifier stays in the HttpOnly cookie, only its hash is sent.
  const verifier = randomBytes(32).toString("base64url");
  const payload: OAuthStatePayload = { nonce, verifier, issuedAt: now };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return { cookieValue: `${encoded}.${signState(encoded, secret)}`, stateParam: nonce, verifier };
}

/** Verifies the signed cookie and that its nonce matches the returned state. */
export function verifyOAuthState(
  cookieValue: string | undefined,
  stateParam: string | undefined,
  secret: string,
  now = Date.now(),
): OAuthStatePayload {
  if (!cookieValue || !stateParam) throw new OAuthConfigError("The Gmail sign-in session expired. Start again.");
  const [encoded, signature] = cookieValue.split(".");
  if (!encoded || !signature) throw new OAuthConfigError("The Gmail sign-in session is malformed. Start again.");

  const expected = Buffer.from(signState(encoded, secret));
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    throw new OAuthConfigError("The Gmail sign-in session failed verification. Start again.");
  }

  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as OAuthStatePayload;
  } catch {
    throw new OAuthConfigError("The Gmail sign-in session is unreadable. Start again.");
  }

  if (payload.nonce !== stateParam) {
    throw new OAuthConfigError("The Gmail sign-in state did not match. Start again.");
  }
  if (!payload.issuedAt || now - payload.issuedAt > STATE_TTL_MS) {
    throw new OAuthConfigError("The Gmail sign-in request expired. Start again.");
  }
  return payload;
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function buildAuthorizationUrl(config: OAuthClientConfig, stateParam: string, verifier: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    // offline + consent is what yields a refresh token for unattended runs.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: stateParam,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

export type FetchLike = typeof fetch;

export type TokenResponse = {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  scope: string;
};

type GoogleTokenBody = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

/** True when Google says the grant itself is gone. */
function isGrantFailure(error: string | undefined): boolean {
  return error === "invalid_grant" || error === "unauthorized_client" || error === "invalid_client";
}

async function postToken(body: URLSearchParams, fetchImpl: FetchLike): Promise<GoogleTokenBody> {
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const payload = (await response.json().catch(() => null)) as GoogleTokenBody | null;
  if (!payload) throw new Error("Google returned an unreadable token response.");
  if (!response.ok || payload.error) {
    if (isGrantFailure(payload.error)) {
      // Do not include Google's description: it can echo request content.
      throw new NeedsReauthorizationError(
        "Google reported that the Gmail authorization is no longer valid. Reconnect Gmail to continue.",
      );
    }
    throw new Error(`Google token request failed (${response.status}).`);
  }
  return payload;
}

export async function exchangeCodeForTokens(options: {
  code: string;
  verifier: string;
  config: OAuthClientConfig;
  fetchImpl?: FetchLike;
}): Promise<TokenResponse> {
  const payload = await postToken(
    new URLSearchParams({
      code: options.code,
      client_id: options.config.clientId,
      client_secret: options.config.clientSecret,
      redirect_uri: options.config.redirectUri,
      grant_type: "authorization_code",
      code_verifier: options.verifier,
    }),
    options.fetchImpl ?? fetch,
  );

  if (!payload.access_token) throw new Error("Google did not return an access token.");
  return {
    accessToken: payload.access_token,
    // Absent on re-consent for an already-authorized account; the caller keeps
    // the stored token rather than overwriting it with null.
    refreshToken: payload.refresh_token ?? null,
    expiresInSeconds: payload.expires_in ?? 3_600,
    scope: payload.scope ?? GMAIL_SCOPES.join(" "),
  };
}

export async function refreshAccessToken(options: {
  refreshToken: string;
  config: OAuthClientConfig;
  fetchImpl?: FetchLike;
}): Promise<{ accessToken: string; expiresInSeconds: number }> {
  const payload = await postToken(
    new URLSearchParams({
      refresh_token: options.refreshToken,
      client_id: options.config.clientId,
      client_secret: options.config.clientSecret,
      grant_type: "refresh_token",
    }),
    options.fetchImpl ?? fetch,
  );
  if (!payload.access_token) throw new NeedsReauthorizationError("Google did not return an access token on refresh.");
  return { accessToken: payload.access_token, expiresInSeconds: payload.expires_in ?? 3_600 };
}

export async function revokeToken(token: string, fetchImpl: FetchLike = fetch): Promise<void> {
  await fetchImpl(REVOKE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
}

export async function fetchProfileEmail(accessToken: string, fetchImpl: FetchLike = fetch): Promise<string> {
  const response = await fetchImpl(`${GMAIL_API_BASE}/profile`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const payload = (await response.json().catch(() => null)) as { emailAddress?: string } | null;
  if (!response.ok || !payload?.emailAddress) throw new Error("Gmail did not return the connected mailbox address.");
  return payload.emailAddress;
}
