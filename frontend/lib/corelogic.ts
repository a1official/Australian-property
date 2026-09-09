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
let tokenPromise: Promise<string> | null = null;
const requestCache = new Map<string, CacheEntry>();
// The sandbox throttles burst traffic aggressively. Serialising calls with a
// small gap keeps one property dossier from exhausting the shared quota.
const MAX_CONCURRENT_COTALITY_REQUESTS = 1;
const MIN_REQUEST_INTERVAL_MS = 500;
let activeRequests = 0;
let lastRequestStartedAt = 0;
const requestQueue: Array<() => void> = [];

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryDelay(retryAfter: string | null, attempt: number) {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 10_000);
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateDelay) && dateDelay > 0) return Math.min(dateDelay, 10_000);
  }
  return 1_000 * 2 ** attempt + Math.floor(Math.random() * 250);
}

async function queueCotalityRequest<T>(operation: () => Promise<T>) {
  await new Promise<void>((resolve) => {
    const start = () => {
      activeRequests += 1;
      resolve();
    };
    if (activeRequests < MAX_CONCURRENT_COTALITY_REQUESTS) start();
    else requestQueue.push(start);
  });

  try {
    const delay = Math.max(0, lastRequestStartedAt + MIN_REQUEST_INTERVAL_MS - Date.now());
    if (delay) await sleep(delay);
    lastRequestStartedAt = Date.now();
    return await operation();
  } finally {
    activeRequests -= 1;
    requestQueue.shift()?.();
  }
}

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

async function refreshAccessToken() {
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

async function accessToken() {
  if (tokenState && tokenState.expiresAt > Date.now() + 30_000) return tokenState.value;
  if (!tokenPromise) tokenPromise = refreshAccessToken().finally(() => { tokenPromise = null; });
  return tokenPromise;
}

async function requestUpstream(path: string, expiresAt: number): Promise<Omit<CoreLogicResult, "cacheStatus">> {
  const { baseUrl } = configuration();
  const cachedAt = new Date().toISOString();
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = await accessToken();
      const response = await queueCotalityRequest(() => fetch(`${baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),
      }));

      if (response.status === 429 && attempt < 2) {
        await sleep(retryDelay(response.headers.get("retry-after"), attempt));
        continue;
      }

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
    }
    throw new Error("CoreLogic request retry limit reached.");
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
    const cached = await existing.promise;
    if (cached.ok) return { ...cached, cacheStatus: "HIT" };
    requestCache.delete(path);
  }

  const expiresAt = now + ttlSeconds * 1_000;
  const promise = requestUpstream(path, expiresAt);
  requestCache.set(path, { expiresAt, promise });
  const result = await promise;

  // Cache only successful responses. Rate limits and entitlement failures must
  // be allowed to recover on the next request instead of being pinned for TTL.
  if (!result.ok) requestCache.delete(path);
  return { ...result, cacheStatus: "MISS" };
}
