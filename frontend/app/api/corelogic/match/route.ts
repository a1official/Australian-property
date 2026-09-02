import { corelogicRequest } from "@/lib/corelogic";

export async function GET(request: Request) {
  try {
    const query = new URL(request.url).searchParams.get("q")?.trim() || "";
    if (query.length < 5) return Response.json({ detail: "Enter at least five address characters." }, { status: 400 });

    const result = await corelogicRequest(
      `/search/au/matcher/address?q=${encodeURIComponent(query.slice(0, 1000))}&clientName=Parcel%20Atlas`,
      { ttlSeconds: 600 },
    );
    if (!result.ok) {
      return Response.json(
        { detail: result.message || "Address matching failed.", upstreamStatus: result.status },
        { status: result.status === 401 ? 401 : result.status === 404 ? 404 : 502 },
      );
    }

    return Response.json(
      { matchDetails: (result.data as { matchDetails?: unknown } | null)?.matchDetails || null, cacheStatus: result.cacheStatus },
      { headers: { "Cache-Control": "private, max-age=60, stale-while-revalidate=300" } },
    );
  } catch (error) {
    return Response.json({ detail: error instanceof Error ? error.message : "Address matching failed." }, { status: 502 });
  }
}
