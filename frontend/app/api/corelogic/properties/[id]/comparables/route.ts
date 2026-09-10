import { corelogicPost } from "@/lib/corelogic";
import { selectQualityComparableRents } from "@/lib/report-html";
import { loadSearchReference, loadSearchSummary, referenceModules } from '@/lib/search-reference';

export const maxDuration = 120;

type JsonRecord = Record<string, unknown>;
type Coordinate = { latitude: number; longitude: number };

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.trim() && Number.isFinite(Number(value))
      ? Number(value)
      : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function coordinate(value: unknown): Coordinate | null {
  const source = record(value);
  const latitude = number(source.latitude);
  const longitude = number(source.longitude);
  return latitude === null || longitude === null ? null : { latitude, longitude };
}

function haversineKm(first: Coordinate, second: Coordinate): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(second.latitude - first.latitude);
  const longitudeDelta = radians(second.longitude - first.longitude);
  const a = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(radians(first.latitude)) * Math.cos(radians(second.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return Math.round(2 * 6371 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 100) / 100;
}

function scoreDifference(reference: number | null, candidate: number | null, exact: number, close: number) {
  if (reference === null || candidate === null) return 0;
  if (reference === candidate) return exact;
  return Math.abs(reference - candidate) === 1 ? close : 0;
}

function scoreCandidate(reference: JsonRecord, candidate: JsonRecord) {
  const referenceType = string(reference.propertyType)?.toUpperCase();
  const candidateType = string(candidate.propertyType)?.toUpperCase();
  const type = referenceType && candidateType && referenceType === candidateType ? 35 : 0;
  const bedrooms = scoreDifference(number(reference.beds), number(candidate.beds), 20, 10);
  const bathrooms = scoreDifference(number(reference.baths), number(candidate.baths), 15, 7);
  const cars = scoreDifference(number(reference.carSpaces), number(candidate.carSpaces), 10, 5);
  const bothFloor = number(reference.floorArea) !== null && number(candidate.floorArea) !== null;
  const referenceArea = number(bothFloor ? reference.floorArea : reference.landArea);
  const candidateArea = number(bothFloor ? candidate.floorArea : candidate.landArea);
  const area = referenceArea !== null && candidateArea !== null && referenceArea > 0 && Math.abs(referenceArea - candidateArea) / referenceArea <= 0.25 ? 10 : 0;
  const distanceKm = number(candidate.distanceKm);
  const location = distanceKm === null ? 0 : distanceKm <= 0.5 ? 10 : distanceKm <= 1 ? 8 : distanceKm <= 3 ? 6 : distanceKm <= 5 ? 4 : 0;
  return { total: type + bedrooms + bathrooms + cars + area + location, breakdown: { type, bedrooms, bathrooms, cars, area, location } };
}

function weeklyRent(campaign: JsonRecord): number | null {
  const value = number(campaign.price);
  const period = string(campaign.period)?.toUpperCase() || "";
  return value !== null && (period === "W" || period.includes("WEEK")) ? value : null;
}

function candidatesFromComparables(payload: unknown, referenceCoordinate: Coordinate | null, reference: JsonRecord) {
  const seen = new Set<number>();
  const output: JsonRecord[] = [];
  const summaries = record(payload).comparablesSummaryList;
  if (!Array.isArray(summaries)) return output;

  for (const summary of summaries) {
    const properties = record(summary).propertyComparableList;
    if (!Array.isArray(properties)) continue;
    for (const item of properties) {
      const source = record(item);
      const property = record(source.property);
      const propertyId = number(property.id);
      if (propertyId === null || propertyId <= 0 || propertyId === reference.propertyId || seen.has(propertyId)) continue;
      seen.add(propertyId);
      const attributes = record(property.attributes);
      const campaign = record(source.comparableForRentPropertyCampaign);
      const candidateCoordinate = coordinate(property.coordinate);
      const apiDistance = number(source.distanceFromTarget);
      const distanceKm = referenceCoordinate && candidateCoordinate
        ? haversineKm(referenceCoordinate, candidateCoordinate)
        : apiDistance;
      const photos = property.propertyPhotoList;
      const defaultPhoto = Array.isArray(photos)
        ? record(photos.find((photo) => record(photo).isDefaultPhoto === true) ?? photos[0])
        : {};
      const candidate = {
        propertyId,
        address: string(record(property.address).singleLine) ?? `Property ${propertyId}`,
        imageUrl: string(defaultPhoto.largePhotoUrl ?? defaultPhoto.mediumPhotoUrl ?? defaultPhoto.thumbnailPhotoUrl),
        campaign: string(campaign.priceDescription),
        weeklyRent: weeklyRent(campaign),
        rentPeriod: string(campaign.period),
        rentDescription: string(campaign.priceDescription),
        propertyType: string(property.propertyType),
        beds: number(attributes.bedrooms),
        baths: number(attributes.bathrooms),
        carSpaces: number(attributes.carSpaces ?? attributes.lockUpGarages),
        floorArea: number(attributes.floorArea),
        landArea: number(attributes.landArea),
        localityId: number(record(record(record(property.address).street).locality).id),
        distanceKm,
      };
      output.push({ ...candidate, score: scoreCandidate(reference, candidate) });
    }
  }
  return output.sort((left, right) => Number(record(right.score).total) - Number(record(left.score).total) || (number(left.distanceKm) ?? Infinity) - (number(right.distanceKm) ?? Infinity));
}

async function enrichSelectedCandidateImages(candidates: JsonRecord[]) {
  // The PDF applies this same selector, so only properties that can appear in
  // the report receive an image lookup. This prevents an unbounded N+1 burst.
  const selectedIds = new Set(
    selectQualityComparableRents(candidates).selected
      .map((candidate) => number(candidate.propertyId))
      .filter((propertyId): propertyId is number => propertyId !== null),
  );
  const queue = candidates.filter((candidate) => selectedIds.has(number(candidate.propertyId) ?? -1));
  const imageByPropertyId = new Map<number, string>();
  let cursor = 0;

  async function worker() {
    while (cursor < queue.length) {
      const candidate = queue[cursor++];
      const propertyId = number(candidate.propertyId);
      const address = string(candidate.address);
      if (propertyId === null || !address) continue;
      try {
        const summary = await loadSearchSummary(String(propertyId), address);
        const photo = record(summary.propertyPhoto);
        const imageUrl = string(photo.largePhotoUrl ?? photo.mediumPhotoUrl ?? photo.thumbnailPhotoUrl);
        if (imageUrl) imageByPropertyId.set(propertyId, imageUrl);
      } catch {
        // A missing photo or a transient enrichment failure must not discard a
        // valid rental comparable; the PDF keeps its existing placeholder.
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, () => worker()));
  return candidates.map((candidate) => {
    const imageUrl = imageByPropertyId.get(number(candidate.propertyId) ?? -1);
    return imageUrl ? { ...candidate, imageUrl } : candidate;
  });
}

async function buildComparables(request: Request, context: RouteContext<"/api/corelogic/properties/[id]/comparables">) {
  const { id } = await context.params;
  if (!/^\d{1,14}$/.test(id)) return Response.json({ detail: "Invalid Cotality property identifier." }, { status: 400 });

  const summary = await loadSearchReference(id, new URL(request.url).searchParams.get('address') || '');
  const modules = referenceModules(summary);
  const reference = { propertyId: Number(id), ...modules.core.data, ...modules.additional.data, localityId: modules.location.data.locality.id };

  // Rule 3 is Cotality's rental-listing comparables rule. We deliberately omit
  // targetPropertyValuation: no sale valuation is fabricated for a rent review.
  const comparablesResponse = await corelogicPost("/property/au/v1/property/comparables.json", {
    propertyId: Number(id),
    comparablesRuleId: 3,
    returnDetailForComparableCategoryId: ["1", "2", "3", "4", "5"],
    returnStatisticsForComparableCategoryId: ["1", "2", "3", "4", "5"],
    limit: 24,
    returnFields: ["address", "attributes"],
  }, { ttlSeconds: 300 });
  if (!comparablesResponse.ok) return Response.json({ detail: "Cotality rental comparables could not be loaded.", upstreamStatus: comparablesResponse.status }, { status: 502 });

  // The service provides its own distance; Haversine is available when a
  // reference coordinate becomes available from a permitted source.
  const referenceCoordinate = coordinate(summary.coordinate);
  const candidates = await enrichSelectedCandidateImages(
    candidatesFromComparables(comparablesResponse.data, referenceCoordinate, reference),
  );
  const summaries: unknown[] = Array.isArray(record(comparablesResponse.data).comparablesSummaryList)
    ? record(comparablesResponse.data).comparablesSummaryList as unknown[]
    : [];
  const totalCandidates = summaries.reduce<number>((total, summary) => total + (number(record(summary).totalProperties) ?? 0), 0);

  return Response.json({
    reference: { ...reference, coordinateAvailable: Boolean(referenceCoordinate) },
    candidatePool: { source: "Cotality rental comparables Rule 3", discovered: totalCandidates, returned: candidates.length },
    candidates,
    cache: { ttlSeconds: 300 },
  }, { headers: { "Cache-Control": "private, max-age=60, stale-while-revalidate=300" } });
}

export async function GET(_request: Request, context: RouteContext<"/api/corelogic/properties/[id]/comparables">) {
  try {
    return await buildComparables(_request, context);
  } catch (error) {
    return Response.json({ detail: error instanceof Error ? error.message : "Comparable data could not be loaded." }, { status: 500 });
  }
}
