/**
 * Direct Cotality report pipeline for the AWS report worker.
 *
 * Calls Cotality itself and never issues an HTTP request back to Vercel, so the
 * report path is genuinely AWS-hosted. Scoring, candidate mapping and image
 * enrichment come from lib/cotality-comparables, which the Vercel comparables
 * route also uses; the logic is therefore identical in both runtimes.
 *
 * Credentials, throttling and retries stay in lib/corelogic. Cotality's OAuth
 * token is cached there per process, which keeps a warm Lambda instance from
 * re-authenticating on every invocation.
 */

import { corelogicPost, corelogicRequest } from "./corelogic";
import {
  candidatesFromComparables,
  comparablesRequestBody,
  coordinate,
  enrichCandidateImages,
  marketRentSummary,
  number as num,
  record as asRecord,
  selectReportCandidates,
  string as str,
  type JsonRecord,
} from "./cotality-comparables";
import { buildReportPdf } from "./report-pdf";
import { comparableAddress, selectQualityComparableRents } from "./report-html";
import { loadSearchReference, loadSearchSummary, referenceModules } from "./search-reference";
import type { MatchOutcome } from "./report-pipeline";

/** Cotality images are supplementary; cap how many a report will embed. */
const MAX_EMBEDDED_IMAGES = 13;

export async function matchAddressDirect(address: string): Promise<MatchOutcome> {
  const [matcher, suggest] = await Promise.all([
    corelogicRequest(`/search/au/matcher/address?q=${encodeURIComponent(address)}&clientName=Parcel%20Atlas`),
    corelogicRequest(`/property/au/v2/suggest.json?q=${encodeURIComponent(address)}`),
  ]);
  if (!matcher.ok && !suggest.ok) {
    throw new Error(`Cotality address search failed (${matcher.status}/${suggest.status}).`);
  }

  const rawSuggestions = asRecord(suggest.data).suggestions;
  const suggestions: JsonRecord[] = Array.isArray(rawSuggestions) ? rawSuggestions.map(asRecord) : [];
  const details = asRecord(asRecord(matcher.data).matchDetails);
  const exactId = num(details.propertyId);

  if (details.matchType === "E" && exactId) {
    const item = suggestions.find((value) => num(value.propertyId) === exactId);
    return { kind: "exact", propertyId: exactId, normalizedAddress: str(item?.suggestion) ?? address };
  }

  // Only an exactly equal suggestion is accepted; anything else needs review so
  // a report is never produced for a different property.
  const exact = suggestions.find((item) => comparableAddress(str(item.suggestion) ?? "") === comparableAddress(address));
  if (exact && num(exact.propertyId)) {
    return { kind: "exact", propertyId: num(exact.propertyId)!, normalizedAddress: str(exact.suggestion) ?? address };
  }
  return suggestions.length
    ? { kind: "needs_review", reason: "No exact Cotality address match." }
    : { kind: "unmatched", reason: "No Cotality property candidate found." };
}

/** Downloads Cotality images as data URIs so the PDF renders offline. */
async function embedImages(sources: Array<string | null | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set(sources.filter((source): source is string => Boolean(source)))].slice(
    0,
    MAX_EMBEDDED_IMAGES,
  );
  const entries: Array<[string, string]> = [];
  for (const source of unique) {
    try {
      const response = await fetch(source, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) continue;
      const contentType = response.headers.get("content-type") ?? "image/jpeg";
      if (!contentType.startsWith("image/")) continue;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength) entries.push([source, `data:${contentType.split(";")[0]};base64,${buffer.toString("base64")}`]);
    } catch {
      // A slow or missing image must never fail the report; the PDF shows a
      // placeholder instead.
    }
  }
  return new Map(entries);
}

/**
 * The existing `{ filename, content, emailData }` contract is preserved so the
 * report worker and preview script keep working. `diagnostics` is additive and
 * optional, carrying the scoring detail needed to verify a dry run.
 */
export type DirectReportResult = Awaited<ReturnType<typeof buildReportPdf>> & {
  diagnostics: {
    candidateCount: number;
    selectedCount: number;
    scoreRange: { min: number; max: number } | null;
    marketRent: ReturnType<typeof marketRentSummary>;
  };
};

/** Builds one property PDF entirely from Cotality data. */
export async function generatePropertyPdfDirect(params: {
  propertyId: number;
  address: string;
}): Promise<DirectReportResult> {
  const summary = await loadSearchReference(String(params.propertyId), params.address);
  const modules = referenceModules(summary);
  const profile = { propertyId: params.propertyId, scope: "overview", modules };

  const locality = asRecord(asRecord(modules.location.data).locality);
  const reference: JsonRecord = {
    propertyId: params.propertyId,
    ...asRecord(modules.core.data),
    ...asRecord(modules.additional.data),
    localityId: num(locality.id),
  };

  const response = await corelogicPost(
    "/property/au/v1/property/comparables.json",
    comparablesRequestBody(params.propertyId),
    { ttlSeconds: 300 },
  );
  if (!response.ok) throw new Error(`Cotality rental comparables failed (${response.status}).`);

  const referenceCoordinate = coordinate(summary.coordinate);
  // Real similarity scores: this replaces the previous score:{total:0} stub.
  const scored = candidatesFromComparables(response.data, referenceCoordinate, reference);
  const selected = selectReportCandidates(scored, selectQualityComparableRents);
  const candidates = await enrichCandidateImages(scored, selected, async (propertyId, address) =>
    (await loadSearchSummary(String(propertyId), address)) as unknown as JsonRecord,
  );

  const totals = selected
    .map((candidate) => Number(asRecord(candidate.score).total))
    .filter((total) => Number.isFinite(total));

  const report = await buildReportPdf({
    address: params.address,
    profile,
    comparables: { reference: { ...reference, coordinateAvailable: Boolean(referenceCoordinate) }, candidates },
    embedImages,
  });

  return {
    ...report,
    diagnostics: {
      candidateCount: candidates.length,
      selectedCount: selected.length,
      scoreRange: totals.length ? { min: Math.min(...totals), max: Math.max(...totals) } : null,
      marketRent: marketRentSummary(selected),
    },
  };
}
