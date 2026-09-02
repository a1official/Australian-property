import { corelogicRequest } from "@/lib/corelogic";

export async function GET(request: Request) {
  try {
    const query = new URL(request.url).searchParams.get("q")?.trim() || "";
    if (query.length < 3) {
      return Response.json({ detail: "Enter at least three characters." }, { status: 400 });
    }

    const result = await corelogicRequest(
      `/property/au/v2/suggest.json?q=${encodeURIComponent(query.slice(0, 160))}`,
      { ttlSeconds: 600 },
    );
    if (!result.ok) {
      return Response.json(
        { detail: result.message || "Address search failed.", upstreamStatus: result.status },
        { status: result.status === 401 ? 401 : 502 },
      );
    }

    const payload = result.data as { suggestions?: unknown[] } | null;
    const suggestions = (payload?.suggestions || []).filter((item) => {
      if (!item || typeof item !== "object") return false;
      const propertyId = Number((item as { propertyId?: unknown }).propertyId);
      return Number.isSafeInteger(propertyId) && propertyId > 0;
    });
    return Response.json(
      { suggestions, cacheStatus: result.cacheStatus },
      { headers: { "Cache-Control": "private, max-age=60, stale-while-revalidate=300" } },
    );
  } catch (error) {
    return Response.json({ detail: error instanceof Error ? error.message : "Address search failed." }, { status: 502 });
  }
}
