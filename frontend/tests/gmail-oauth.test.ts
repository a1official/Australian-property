/**
 * Covers the OAuth flow: scopes and offline access, state/PKCE validation,
 * token exchange, refresh, and safe handling of a revoked grant.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  GMAIL_SCOPES,
  NeedsReauthorizationError,
  OAuthConfigError,
  buildAuthorizationUrl,
  createOAuthState,
  exchangeCodeForTokens,
  pkceChallenge,
  readOAuthClientConfig,
  refreshAccessToken,
  verifyOAuthState,
} from "../lib/gmail-oauth";

const CONFIG = {
  clientId: "test-client-id.apps.googleusercontent.com",
  clientSecret: "test-client-secret-value",
  redirectUri: "http://localhost:3004/api/gmail/oauth/callback",
};

function jsonFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

test("configuration requires all three OAuth values", () => {
  assert.throws(
    () => readOAuthClientConfig({ GMAIL_CLIENT_ID: "only-id" } as unknown as NodeJS.ProcessEnv),
    OAuthConfigError,
  );
  const config = readOAuthClientConfig({
    GMAIL_CLIENT_ID: CONFIG.clientId,
    GMAIL_CLIENT_SECRET: CONFIG.clientSecret,
    GMAIL_REDIRECT_URI: CONFIG.redirectUri,
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(config.clientId, CONFIG.clientId);
});

test("only the two required Gmail scopes are requested", () => {
  assert.deepEqual(GMAIL_SCOPES, [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
  ]);
  // Broad mailbox access must not creep in.
  assert.ok(!GMAIL_SCOPES.includes("https://mail.google.com/"));
  assert.ok(!GMAIL_SCOPES.some((scope) => scope.endsWith("gmail.readonly")));
});

test("the authorization URL requests offline access and consent", () => {
  const { stateParam, verifier } = createOAuthState(CONFIG.clientSecret);
  const url = new URL(buildAuthorizationUrl(CONFIG, stateParam, verifier));

  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("access_type"), "offline", "offline access yields a refresh token");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("state"), stateParam);
  assert.equal(url.searchParams.get("scope"), GMAIL_SCOPES.join(" "));
});

test("PKCE sends only the challenge, never the verifier", () => {
  const { stateParam, verifier } = createOAuthState(CONFIG.clientSecret);
  const url = new URL(buildAuthorizationUrl(CONFIG, stateParam, verifier));
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), pkceChallenge(verifier));
  assert.ok(!url.toString().includes(verifier), "the verifier must stay in the cookie");
});

test("the client secret is never placed in the authorization URL", () => {
  const { stateParam, verifier } = createOAuthState(CONFIG.clientSecret);
  const url = buildAuthorizationUrl(CONFIG, stateParam, verifier);
  assert.ok(!url.includes(CONFIG.clientSecret));
});

test("valid state round-trips and yields the verifier", () => {
  const { cookieValue, stateParam, verifier } = createOAuthState(CONFIG.clientSecret);
  const payload = verifyOAuthState(cookieValue, stateParam, CONFIG.clientSecret);
  assert.equal(payload.verifier, verifier);
});

test("a mismatched state parameter is rejected", () => {
  const { cookieValue } = createOAuthState(CONFIG.clientSecret);
  assert.throws(() => verifyOAuthState(cookieValue, "attacker-supplied-nonce", CONFIG.clientSecret), OAuthConfigError);
});

test("a tampered state cookie is rejected", () => {
  const { cookieValue, stateParam } = createOAuthState(CONFIG.clientSecret);
  const [encoded] = cookieValue.split(".");
  assert.throws(() => verifyOAuthState(`${encoded}.forged-signature`, stateParam, CONFIG.clientSecret), OAuthConfigError);
});

test("a state signed with a different secret is rejected", () => {
  const { cookieValue, stateParam } = createOAuthState("some-other-secret");
  assert.throws(() => verifyOAuthState(cookieValue, stateParam, CONFIG.clientSecret), OAuthConfigError);
});

test("an expired state is rejected", () => {
  const issued = Date.now() - 20 * 60_000;
  const { cookieValue, stateParam } = createOAuthState(CONFIG.clientSecret, issued);
  assert.throws(() => verifyOAuthState(cookieValue, stateParam, CONFIG.clientSecret), OAuthConfigError);
});

test("a missing cookie or state is rejected", () => {
  assert.throws(() => verifyOAuthState(undefined, "nonce", CONFIG.clientSecret), OAuthConfigError);
  assert.throws(() => verifyOAuthState("cookie.sig", undefined, CONFIG.clientSecret), OAuthConfigError);
});

test("a code exchange returns the refresh token and scopes", async () => {
  const tokens = await exchangeCodeForTokens({
    code: "auth-code",
    verifier: "verifier",
    config: CONFIG,
    fetchImpl: jsonFetch(200, {
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 3599,
      scope: GMAIL_SCOPES.join(" "),
    }),
  });
  assert.equal(tokens.refreshToken, "refresh-token");
  assert.equal(tokens.accessToken, "access-token");
});

test("a re-consent without a refresh token yields null, not a failure", async () => {
  // Google omits refresh_token when the account is already authorized. The
  // caller must keep the stored token rather than nulling a working grant.
  const tokens = await exchangeCodeForTokens({
    code: "auth-code",
    verifier: "verifier",
    config: CONFIG,
    fetchImpl: jsonFetch(200, { access_token: "access-token", expires_in: 3599 }),
  });
  assert.equal(tokens.refreshToken, null);
  assert.equal(tokens.accessToken, "access-token");
});

test("invalid_grant becomes needs_reauthorization", async () => {
  await assert.rejects(
    () =>
      refreshAccessToken({
        refreshToken: "revoked",
        config: CONFIG,
        fetchImpl: jsonFetch(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }),
      }),
    NeedsReauthorizationError,
  );
});

test("a provider error description is never forwarded", async () => {
  await assert.rejects(
    () =>
      refreshAccessToken({
        refreshToken: "revoked",
        config: CONFIG,
        fetchImpl: jsonFetch(400, { error: "invalid_grant", error_description: "secret-ish upstream detail" }),
      }),
    (error: unknown) => error instanceof Error && !error.message.includes("secret-ish upstream detail"),
  );
});

test("a token refresh returns a short-lived access token", async () => {
  const result = await refreshAccessToken({
    refreshToken: "stored-refresh-token",
    config: CONFIG,
    fetchImpl: jsonFetch(200, { access_token: "fresh-access-token", expires_in: 3599 }),
  });
  assert.equal(result.accessToken, "fresh-access-token");
  assert.equal(result.expiresInSeconds, 3599);
});

test("a generic token failure does not claim reauthorization is needed", async () => {
  await assert.rejects(
    () => refreshAccessToken({ refreshToken: "t", config: CONFIG, fetchImpl: jsonFetch(500, { error: "backend_error" }) }),
    (error: unknown) => error instanceof Error && !(error instanceof NeedsReauthorizationError),
  );
});
