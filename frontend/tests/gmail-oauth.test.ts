/**
 * Covers the OAuth flow: scopes and offline access, state/PKCE validation,
 * token exchange, refresh, and safe handling of a revoked grant.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { GmailApiClient } from "../lib/gmail-api";
import {
  GMAIL_SCOPES,
  NeedsReauthorizationError,
  OAuthConfigError,
  buildAuthorizationUrl,
  createOAuthState,
  exchangeCodeForTokens,
  fetchProfileEmail,
  pkceChallenge,
  readOAuthClientConfig,
  readOAuthClientCredentials,
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

test("the authorization-code configuration requires a redirect target", () => {
  assert.throws(
    () => readOAuthClientConfig({ GMAIL_CLIENT_ID: "only-id" } as unknown as NodeJS.ProcessEnv),
    OAuthConfigError,
  );
  // Client credentials alone are not enough for the interactive flow.
  assert.throws(
    () =>
      readOAuthClientConfig({
        GMAIL_CLIENT_ID: CONFIG.clientId,
        GMAIL_CLIENT_SECRET: CONFIG.clientSecret,
      } as unknown as NodeJS.ProcessEnv),
    OAuthConfigError,
  );
  const config = readOAuthClientConfig({
    GMAIL_CLIENT_ID: CONFIG.clientId,
    GMAIL_CLIENT_SECRET: CONFIG.clientSecret,
    GMAIL_REDIRECT_URI: CONFIG.redirectUri,
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(config.clientId, CONFIG.clientId);
});

test("the redirect URI is derived from the base URL when not set explicitly", () => {
  const config = readOAuthClientConfig({
    GMAIL_CLIENT_ID: CONFIG.clientId,
    GMAIL_CLIENT_SECRET: CONFIG.clientSecret,
    PARCEL_ATLAS_BASE_URL: "https://australian-property.vercel.app/",
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(config.redirectUri, "https://australian-property.vercel.app/api/gmail/oauth/callback");
});

test("refresh-only credentials do not require a redirect URI", () => {
  // The delivery Lambda's secret carries no GMAIL_REDIRECT_URI. Requiring one
  // here previously failed every unattended send for a value Google never sees.
  const credentials = readOAuthClientCredentials({
    GMAIL_CLIENT_ID: CONFIG.clientId,
    GMAIL_CLIENT_SECRET: CONFIG.clientSecret,
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(credentials.clientId, CONFIG.clientId);
  assert.equal(credentials.clientSecret, CONFIG.clientSecret);

  assert.throws(
    () => readOAuthClientCredentials({ GMAIL_CLIENT_ID: CONFIG.clientId } as unknown as NodeJS.ProcessEnv),
    OAuthConfigError,
  );
});

test("the refresh grant sends no redirect_uri", async () => {
  let sent = "";
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent = String(init.body);
    return new Response(JSON.stringify({ access_token: "fresh", expires_in: 3599 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const result = await refreshAccessToken({
    refreshToken: "stored-refresh-token",
    config: { clientId: CONFIG.clientId, clientSecret: CONFIG.clientSecret },
    fetchImpl,
  });

  assert.equal(result.accessToken, "fresh");
  assert.ok(sent.includes("grant_type=refresh_token"));
  assert.ok(!sent.includes("redirect_uri"));
});

test("the minimal Gmail and identity scopes are requested", () => {
  assert.deepEqual(GMAIL_SCOPES, [
    "openid",
    "email",
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

test("user-info email is used when the Gmail profile response is unavailable", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return calls === 1
      ? new Response(JSON.stringify({ error: { status: "UNAVAILABLE" } }), { status: 503 })
      : new Response(JSON.stringify({ email: "owner@example.com", email_verified: true }), { status: 200 });
  }) as unknown as typeof fetch;

  assert.equal(await fetchProfileEmail("access-token", fetchImpl), "owner@example.com");
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

// ---------------------------------------------------------------------------
// Transport resilience
// ---------------------------------------------------------------------------

test("a transient transport error on a read is retried", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    // Mirrors the intermittent "fetch failed" seen against Gmail: no HTTP
    // status, just a dropped connection.
    if (calls === 1) throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ messages: [{ id: "m1", threadId: "t1" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const messages = await new GmailApiClient("token", fetchImpl).listCandidateMessages("has:attachment", 5);
  assert.equal(calls, 2);
  assert.deepEqual(messages, [{ id: "m1", threadId: "t1" }]);
});

test("a send is never retried, so a blip cannot duplicate an email", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;

  await assert.rejects(() => new GmailApiClient("token", fetchImpl).sendMessage("raw-mime"));
  assert.equal(calls, 1);
});

test("a rejected access token is surfaced immediately rather than retried", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: "invalid" } }), { status: 401 });
  }) as unknown as typeof fetch;

  await assert.rejects(
    () => new GmailApiClient("stale", fetchImpl).listCandidateMessages("has:attachment", 5),
    NeedsReauthorizationError,
  );
  assert.equal(calls, 1);
});
