#!/usr/bin/env tsx
/**
 * Verifies the configured Cotality credentials with the smallest possible call.
 *
 * One token request, then one cheap lookup. Deliberately minimal so it cannot
 * contribute to rate-limit pressure. Prints no secret values.
 */

import { existsSync, readFileSync } from "node:fs";
import * as nodePath from "node:path";

for (const candidate of [
  nodePath.resolve(process.cwd(), "..", ".env"),
  nodePath.resolve(process.cwd(), ".env"),
  nodePath.resolve(process.cwd(), ".env.local"),
]) {
  if (!existsSync(candidate)) continue;
  for (const line of readFileSync(candidate, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
}

const clientId = process.env.CORELOGIC_CLIENT_ID?.trim() ?? "";
const clientSecret = process.env.CORELOGIC_CLIENT_SECRET?.trim() ?? "";
const baseUrl = (process.env.CORELOGIC_SANDBOX_BASE_URL || "https://api-sbox.corelogic.asia").replace(/\/$/, "");

async function run(): Promise<void> {
  // Shape checks first: a transcription slip is cheaper to catch here than in a
  // failed OAuth round trip.
  console.log(`client id length:     ${clientId.length}`);
  console.log(`client secret length: ${clientSecret.length}`);
  console.log(`id charset ok:        ${/^[A-Za-z0-9]+$/.test(clientId)}`);
  console.log(`secret charset ok:    ${/^[A-Za-z0-9]+$/.test(clientSecret)}`);
  console.log(`base url:             ${baseUrl}`);

  if (!clientId || !clientSecret) {
    console.log("\nVERDICT: credentials are not configured.");
    process.exitCode = 1;
    return;
  }

  const response = await fetch(`${baseUrl}/access/as/token.oauth2`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });

  const payload = (await response.json().catch(() => null)) as
    | { access_token?: string; expires_in?: number; error?: string; error_description?: string }
    | null;

  console.log(`\ntoken request http:   ${response.status}`);
  if (!response.ok || !payload?.access_token) {
    // Report the provider's error code, never the credential.
    console.log(`error:                ${payload?.error ?? "unknown"}`);
    console.log(`description:          ${payload?.error_description ?? "(none)"}`);
    console.log(
      response.status === 401
        ? "\nVERDICT: rejected. The client id or secret is wrong, possibly a transcription error."
        : response.status === 429
          ? "\nVERDICT: rate limited. The credentials may be valid; retry after the cooldown."
          : "\nVERDICT: token request failed.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`token received:       yes (expires in ${payload.expires_in ?? "?"}s)`);

  // One inexpensive read to confirm the token is actually accepted downstream.
  const probe = await fetch(`${baseUrl}/property/au/v2/suggest.json?q=${encodeURIComponent("1 Macquarie Street Sydney NSW 2000")}`, {
    headers: { Authorization: `Bearer ${payload.access_token}`, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await probe.json().catch(() => null)) as { suggestions?: unknown[] } | null;
  console.log(`suggest probe http:   ${probe.status}`);
  console.log(`suggestions:          ${Array.isArray(body?.suggestions) ? body!.suggestions!.length : 0}`);

  console.log(
    probe.ok
      ? "\nVERDICT: credentials are valid and the API is responding."
      : probe.status === 429
        ? "\nVERDICT: credentials are valid, but the API is still rate limited. Wait for the cooldown."
        : `\nVERDICT: authenticated, but the data probe returned ${probe.status}.`,
  );
  if (!probe.ok && probe.status !== 429) process.exitCode = 1;
}

void run().catch((error: unknown) => {
  console.error(`verification failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
