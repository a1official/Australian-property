import "server-only";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type TokenState = { value: string; expiresAt: number } | null;
type CoreLogicResult = {
  ok: boolean;
  status: number;
  data: unknown;
  message?: string;
  cacheStatus: "HIT" | "MISS";
  cachedAt: string;
  expiresAt: string;
};
type RequestOptions = { ttlSeconds?: number; bypassCache?: boolean };
type CacheEntry = { expiresAt: number; promise: Promise<Omit<CoreLogicResult, "cacheStatus">> };

let tokenState: TokenState = null;
const requestCache = new Map<string, CacheEntry>();

function readWorkspaceEnv() {
  try {
    const content = readFileSync(resolve(process.cwd(), "..", ".env"), "utf8");
    const values: Record<string, string> = {};
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^([^#][^=]*)=(.*)$/);
      if (match) values[match[1].trim()] = match[2].trim();
    }
    return values;
  } catch {
    return {};
  }
}

function configuration() {
  const fallback = readWorkspaceEnv();
  return {
    clientId: process.env.CORELOGIC_CLIENT_ID || fallback.CORELOGIC_CLIENT_ID,
    clientSecret: process.env.CORELOGIC_CLIENT_SECRET || fallback.CORELOGIC_CLIENT_SECRET,
    baseUrl:
      process.env.CORELOGIC_SANDBOX_BASE_URL ||
      fallback.CORELOGIC_SANDBOX_BASE_URL ||
      "https://api-sbox.corelogic.asia",
  };
}

async function accessToken() {
  if (tokenState && tokenState.expiresAt > Date.now() + 30_000) return tokenState.value;

  const { clientId, clientSecret, baseUrl } = configuration();
  if (!clientId || !clientSecret) {
    throw new Error("CoreLogic credentials are not configured on the server.");
  }

  const response = await fetch(`${baseUrl}/access/as/token.oauth2`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });

  const payload = (await response.json().catch(() => null)) as
    | { access_token?: string; expires_in?: number; error_description?: string }
    | null;
  if (!response.ok || !payload?.access_token) {
    throw new Error(payload?.error_description || `CoreLogic authentication failed (${response.status}).`);
  }

  tokenState = {
    value: payload.access_token,
    expiresAt: Date.now() + Math.max(60, payload.expires_in || 300) * 1000,
  };
  return tokenState.value;
}

async function requestUpstream(path: string, expiresAt: number): Promise<Omit<CoreLogicResult, "cacheStatus">> {
  const { baseUrl } = configuration();
  const cachedAt = new Date().toISOString();
  try {
    const token = await accessToken();
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
    const text = await response.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      data,
      message: response.ok ? undefined : `CoreLogic returned ${response.status}.`,
      cachedAt,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  } catch (error) {
    return {
      ok: false,
      status: 502,
      data: null,
      message: error instanceof Error ? error.message : "CoreLogic could not be reached.",
      cachedAt,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }
}

export async function corelogicRequest(path: string, options: RequestOptions = {}): Promise<CoreLogicResult> {
  const ttlSeconds = Math.max(15, Math.min(options.ttlSeconds ?? 300, 3_600));
  const now = Date.now();
  const existing = requestCache.get(path);
  if (!options.bypassCache && existing && existing.expiresAt > now) {
    return { ...(await existing.promise), cacheStatus: "HIT" };
  }

  const expiresAt = now + ttlSeconds * 1_000;
  const promise = requestUpstream(path, expiresAt);
  requestCache.set(path, { expiresAt, promise });
  const result = await promise;

  // Do not pin transient upstream/server failures in the cache.
  if (result.status >= 500) requestCache.delete(path);
  return { ...result, cacheStatus: "MISS" };
}
