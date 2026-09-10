import { corelogicPost } from "@/lib/corelogic";
import {
  candidatesFromComparables,
  comparablesRequestBody,
  coordinate,
  enrichCandidateImages,
  number,
  record,
  selectReportCandidates,
} from "@/lib/cotality-comparables";
import { selectQualityComparableRents } from "@/lib/report-html";
import { loadSearchReference, loadSearchSummary, referenceModules } from "@/lib/search-reference";

export const maxDuration = 120;

async function buildComparables(request: Request, context: RouteContext<"/api/corelogic/properties/[id]/comparables">) {
  const { id } = await context.params;
  if (!/^\d{1,14}$/.test(id)) return Response.json({ detail: "Invalid Cotality property identifier." }, { status: 400 });

  const summary = await loadSearchReference(id, new URL(request.url).searchParams.get("address") || "");
  const modules = referenceModules(summary);
  const reference = {
    propertyId: Number(id),
    ...modules.core.data,
    ...modules.additional.data,
    localityId: modules.location.data.locality.id,
  };

  // Scoring, mapping and enrichment live in lib/cotality-comparables so the AWS
  // report Lambda applies byte-identical logic without calling this route.
  const comparablesResponse = await corelogicPost(
    "/property/au/v1/property/comparables.json",
    comparablesRequestBody(Number(id)),
    { ttlSeconds: 300 },
  );
  if (!comparablesResponse.ok) {
    return Response.json(
      { detail: "Cotality rental comparables could not be loaded.", upstreamStatus: comparablesResponse.status },
      { status: 502 },
    );
  }

  const referenceCoordinate = coordinate(summary.coordinate);
  const scored = candidatesFromComparables(comparablesResponse.data, referenceCoordinate, reference);
  // Enrich only what the report can display, which bounds the lookup count.
  const selected = selectReportCandidates(scored, selectQualityComparableRents);
  const candidates = await enrichCandidateImages(scored, selected, async (propertyId, address) =>
    (await loadSearchSummary(String(propertyId), address)) as unknown as Record<string, unknown>,
  );

  const summaries: unknown[] = Array.isArray(record(comparablesResponse.data).comparablesSummaryList)
    ? (record(comparablesResponse.data).comparablesSummaryList as unknown[])
    : [];
  const totalCandidates = summaries.reduce<number>(
    (total, item) => total + (number(record(item).totalProperties) ?? 0),
    0,
  );

  return Response.json(
    {
      reference: { ...reference, coordinateAvailable: Boolean(referenceCoordinate) },
      candidatePool: {
        source: "Cotality rental comparables Rule 3",
        discovered: totalCandidates,
        returned: candidates.length,
        selectedForReport: selected.length,
      },
      candidates,
      cache: { ttlSeconds: 300 },
    },
    { headers: { "Cache-Control": "private, max-age=60, stale-while-revalidate=300" } },
  );
}

export async function GET(_request: Request, context: RouteContext<"/api/corelogic/properties/[id]/comparables">) {
  try {
    return await buildComparables(_request, context);
  } catch (error) {
    return Response.json(
      { detail: error instanceof Error ? error.message : "Comparable data could not be loaded." },
      { status: 500 },
    );
  }
}
