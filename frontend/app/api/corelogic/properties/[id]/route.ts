import { corelogicRequest } from "@/lib/corelogic";

export const maxDuration = 120;

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

type ModuleName = keyof typeof modules;
const moduleScopes: Record<string, ModuleName[]> = {
  overview: ["core", "additional", "location", "lastSale", "forSale", "forRent", "avm", "rentalAvm", "images"],
  market: ["lastSale", "sales", "forSale", "forRent", "onMarketSales", "onMarketRent"],
  legal: ["legal", "contacts", "occupancy", "developmentApplications", "site"],
  intelligence: ["features", "sales", "onMarketSales", "onMarketRent", "statistics", "site"],
  all: Object.keys(modules) as ModuleName[],
};

export async function GET(request: Request, context: RouteContext<"/api/corelogic/properties/[id]">) {
  try {
    const { id } = await context.params;
    if (!/^\d{1,14}$/.test(id)) {
      return Response.json({ detail: "Invalid CoreLogic property identifier." }, { status: 400 });
    }

    const scope = new URL(request.url).searchParams.get("scope") || "overview";
    const selectedModules = moduleScopes[scope];
    if (!selectedModules) return Response.json({ detail: "Invalid property-data scope." }, { status: 400 });

    const entries = await Promise.all(
      selectedModules.map(async (name) => [name, await corelogicRequest(modules[name](id))] as const),
    );
    const data = Object.fromEntries(entries);
    const successfulModules = entries.filter(([, result]) => result.ok).length;
    const cacheHits = entries.filter(([, result]) => result.cacheStatus === "HIT").length;

    return Response.json(
      {
        propertyId: Number(id),
        scope,
        generatedAt: new Date().toISOString(),
        successfulModules,
        totalModules: entries.length,
        availableModules: Object.keys(modules).length,
        cache: { hits: cacheHits, misses: entries.length - cacheHits, ttlSeconds: 300 },
        modules: data,
      },
      { headers: { "Cache-Control": "private, max-age=60, stale-while-revalidate=300" } },
    );
  } catch (error) {
    return Response.json({ detail: error instanceof Error ? error.message : "Property data could not be loaded." }, { status: 500 });
  }
}
