import { corelogicRequest } from "@/lib/corelogic";

const modules = {
  core: (id: string) => `/property-details/au/properties/${id}/attributes/core`,
  additional: (id: string) => `/property-details/au/properties/${id}/attributes/additional`,
  location: (id: string) => `/property-details/au/properties/${id}/location`,
  site: (id: string) => `/property-details/au/properties/${id}/site`,
  features: (id: string) => `/property-details/au/properties/${id}/features`,
  legal: (id: string) => `/property-details/au/properties/${id}/legal`,
  contacts: (id: string) => `/property-details/au/properties/${id}/contacts`,
  occupancy: (id: string) => `/property-details/au/properties/${id}/occupancy`,
  developmentApplications: (id: string) => `/property-details/au/properties/${id}/developmentApplication`,
  lastSale: (id: string) => `/property-details/au/properties/${id}/sales/last`,
  sales: (id: string) => `/property-details/au/properties/${id}/sales`,
  timeline: (id: string) => `/property-timeline/au/properties/${id}/timeline`,
  statistics: (id: string) => `/property-details/au/properties/${id}/statisticReferences`,
  forSale: (id: string) => `/property/au/v1/property/${id}/for-sale-advertisements.json`,
  forRent: (id: string) => `/property/au/v1/property/${id}/for-rent-advertisements.json`,
  onMarketSales: (id: string) => `/property-details/au/properties/${id}/otm/campaign/sales`,
  onMarketRent: (id: string) => `/property-details/au/properties/${id}/otm/campaign/rent`,
  avm: (id: string) => `/avm/au/properties/${id}/avm/intellival/consumer/current`,
  rentalAvm: (id: string) => `/property/au/v1/property/${id}/rentalAvm.json`,
  images: (id: string) => `/property-details/au/properties/${id}/images`,
} as const;

export async function GET(_request: Request, context: RouteContext<"/api/corelogic/properties/[id]">) {
  const { id } = await context.params;
  if (!/^\d{1,14}$/.test(id)) {
    return Response.json({ detail: "Invalid CoreLogic property identifier." }, { status: 400 });
  }

  const entries = await Promise.all(
    Object.entries(modules).map(async ([name, path]) => [name, await corelogicRequest(path(id))] as const),
  );
  const data = Object.fromEntries(entries);
  const successfulModules = entries.filter(([, result]) => result.ok).length;
  const cacheHits = entries.filter(([, result]) => result.cacheStatus === "HIT").length;

  return Response.json(
    {
      propertyId: Number(id),
      generatedAt: new Date().toISOString(),
      successfulModules,
      totalModules: entries.length,
      cache: { hits: cacheHits, misses: entries.length - cacheHits, ttlSeconds: 300 },
      modules: data,
    },
    { headers: { "Cache-Control": "private, max-age=60, stale-while-revalidate=300" } },
  );
}
