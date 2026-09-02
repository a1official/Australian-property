/**
 * Node-side report pipeline used by the scheduled worker.
 *
 * Talks to the deployed Vercel API routes over HTTPS, so Cotality credentials
 * stay in one place and the worker needs no browser to build a report. This
 * replaces the previous approach of driving the batch UI with Playwright.
 */

import { buildReportHtml, comparableAddress, reportFilenameFor, record } from "./report-html";

const MAX_EMBEDDED_IMAGES = 13;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

export type MatchOutcome =
  | { kind: "exact"; propertyId: number; normalizedAddress: string }
  | { kind: "needs_review"; reason: string }
  | { kind: "unmatched"; reason: string };

export class UpstreamError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
  }
}

export type FetchLike = typeof fetch;

export type PipelineClientOptions = {
  baseUrl: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

async function requestJson<T>(
  url: string,
  options: { fetchImpl: FetchLike; timeoutMs: number },
): Promise<T> {
  const response = await options.fetchImpl(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const body = await response.text();
  let payload: unknown = null;
  if (body) {
    try {
      payload = JSON.parse(body);
    } catch {
      throw new UpstreamError(`Non-JSON response (${response.status}) from ${new URL(url).pathname}`, response.status);
    }
  }
  if (!response.ok) {
    const detail = record(payload).detail;
    throw new UpstreamError(
      typeof detail === "string" ? detail : `Request failed (${response.status}).`,
      response.status,
    );
  }
  return payload as T;
}

/**
 * Resolves one CSV address. Only an exact Address Matcher result or an exactly
 * equal suggestion is accepted; anything else needs human review so the system
 * never guesses a property.
 */
export async function matchAddress(
  address: string,
  options: PipelineClientOptions,
): Promise<MatchOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const base = options.baseUrl.replace(/\/$/, "");

  const [matcher, suggest] = await Promise.allSettled([
    requestJson<{ matchDetails: { propertyId?: number | string; matchType?: string } | null }>(
      `${base}/api/corelogic/match?q=${encodeURIComponent(address)}`,
      { fetchImpl, timeoutMs },
    ),
    requestJson<{ suggestions: Array<{ propertyId: number | string; suggestion: string }> }>(
      `${base}/api/corelogic/search?q=${encodeURIComponent(address)}`,
      { fetchImpl, timeoutMs },
    ),
  ]);

  // A transient upstream failure must surface as retryable, not as "unmatched",
  // otherwise a Cotality 429 would permanently discard a valid address.
  if (matcher.status === "rejected" && suggest.status === "rejected") {
    throw matcher.reason instanceof Error ? matcher.reason : new Error(String(matcher.reason));
  }
  for (const outcome of [matcher, suggest]) {
    if (outcome.status === "rejected" && outcome.reason instanceof UpstreamError && outcome.reason.status >= 500) {
      throw outcome.reason;
    }
    if (outcome.status === "rejected" && outcome.reason instanceof UpstreamError && outcome.reason.status === 429) {
      throw outcome.reason;
    }
  }

  const matchDetails = matcher.status === "fulfilled" ? matcher.value.matchDetails : null;
  const suggestions = suggest.status === "fulfilled" ? (suggest.value.suggestions ?? []).slice(0, 5) : [];

  const matcherId = Number(matchDetails?.propertyId);
  if (matchDetails?.matchType === "E" && Number.isSafeInteger(matcherId) && matcherId > 0) {
    const matching = suggestions.find((item) => Number(item.propertyId) === matcherId);
    return { kind: "exact", propertyId: matcherId, normalizedAddress: matching?.suggestion || address };
  }

  const exactSuggestion = suggestions.find(
    (item) => comparableAddress(item.suggestion) === comparableAddress(address),
  );
  if (exactSuggestion) {
    const propertyId = Number(exactSuggestion.propertyId);
    if (Number.isSafeInteger(propertyId) && propertyId > 0) {
      return { kind: "exact", propertyId, normalizedAddress: exactSuggestion.suggestion };
    }
  }

  if (suggestions.length) {
    return {
      kind: "needs_review",
      reason: `No exact Cotality match. ${suggestions.length} candidate suggestion(s) require manual selection.`,
    };
  }
  return { kind: "unmatched", reason: "No Cotality property candidate found for this address." };
}

/** Embeds Cotality images as data URIs. Failures degrade to no image. */
export function createNodeImageEmbedder(options: PipelineClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.baseUrl.replace(/\/$/, "");

  return async function embedImages(sources: Array<string | null | undefined>): Promise<Map<string, string>> {
    const unique = [...new Set(sources.filter((source): source is string => Boolean(source)))].slice(
      0,
      MAX_EMBEDDED_IMAGES,
    );
    const entries = await Promise.all(
      unique.map(async (source) => {
        try {
          const response = await fetchImpl(`${base}/api/corelogic/image?src=${encodeURIComponent(source)}`, {
            signal: AbortSignal.timeout(15_000),
          });
          if (!response.ok) return [source, ""] as const;
          const contentType = response.headers.get("content-type") || "";
          if (!contentType.startsWith("image/")) return [source, ""] as const;
          const buffer = Buffer.from(await response.arrayBuffer());
          if (!buffer.byteLength || buffer.byteLength > MAX_IMAGE_BYTES) return [source, ""] as const;
          return [source, `data:${contentType.split(";")[0]};base64,${buffer.toString("base64")}`] as const;
        } catch {
          // Images are supplementary; never fail a report because of one.
          return [source, ""] as const;
        }
      }),
    );
    return new Map(entries.filter(([, value]) => value));
  };
}

/** Fetches the dossier and comparables, then renders the report HTML. */
export async function generatePropertyReport(
  params: { propertyId: number; address: string },
  options: PipelineClientOptions,
): Promise<{ filename: string; html: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const base = options.baseUrl.replace(/\/$/, "");

  const profile = await requestJson<unknown>(`${base}/api/corelogic/properties/${params.propertyId}`, {
    fetchImpl,
    timeoutMs,
  });
  const comparables = await requestJson<unknown>(
    `${base}/api/corelogic/properties/${params.propertyId}/comparables`,
    { fetchImpl, timeoutMs },
  );

  const html = await buildReportHtml({
    address: params.address,
    profile,
    comparables,
    embedImages: createNodeImageEmbedder(options),
  });

  return { filename: reportFilenameFor(params.propertyId), html };
}
