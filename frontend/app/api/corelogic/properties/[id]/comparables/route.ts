import { corelogicRequest } from "@/lib/corelogic";

export const maxDuration = 60;

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function findValue(value: unknown, keys: string[]): unknown {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  const queue: unknown[] = [value];
  while (queue.length) {
    const item = queue.shift();
    if (!item || typeof item !== "object") continue;
    for (const [key, child] of Object.entries(item as JsonRecord)) {
      if (wanted.has(key.toLowerCase()) && child !== null && child !== undefined) return child;
      if (child && typeof child === "object") queue.push(child);
    }
  }
  return null;
}

function candidateRecords(value: unknown): JsonRecord[] {
  const seen = new Set<number>();
  const output: JsonRecord[] = [];
  const queue: unknown[] = [value];
  while (queue.length) {
    const item = queue.shift();
    if (!item || typeof item !== "object") continue;
    if (Array.isArray(item)) {
      queue.push(...item);
      continue;
    }
    const itemRecord = item as JsonRecord;
    const id = number(itemRecord.id ?? itemRecord.propertyId);
    const address = findValue(itemRecord, ["singleLine", "address", "displayAddress"]);
    if (id && id > 0 && (address || itemRecord.attributes || itemRecord.propertyType) && !seen.has(id)) {
      seen.add(id);
      output.push(itemRecord);
    }
    queue.push(...Object.values(itemRecord));
  }
  return output;
}

function coordinates(value: unknown) {
  const latitude = number(findValue(value, ["latitude", "lat"]));
  const longitude = number(findValue(value, ["longitude", "lng", "lon"]));
  return latitude !== null && longitude !== null ? { latitude, longitude } : null;
}

function haversineKm(first: { latitude: number; longitude: number }, second: { latitude: number; longitude: number }) {
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
  const typeMatch = string(reference.propertyType)?.toUpperCase() === string(candidate.propertyType)?.toUpperCase();
  const type = typeMatch ? 35 : 0;
  const bedrooms = scoreDifference(number(reference.beds), number(candidate.beds), 20, 10);
  const bathrooms = scoreDifference(number(reference.baths), number(candidate.baths), 15, 7);
  const cars = scoreDifference(number(reference.carSpaces), number(candidate.carSpaces), 10, 5);
  const referenceArea = number(reference.floorArea) ?? number(reference.landArea);
  const candidateArea = number(candidate.floorArea) ?? number(candidate.landArea);
  const area = referenceArea !== null && candidateArea !== null && referenceArea > 0 && Math.abs(referenceArea - candidateArea) / referenceArea <= 0.25 ? 10 : 0;
  const distanceKm = number(candidate.distanceKm);
  const locality = reference.localityId === candidate.localityId;
  const location = distanceKm === null ? (locality ? 5 : 0) : distanceKm <= 0.5 ? 10 : distanceKm <= 1 ? 8 : distanceKm <= 3 ? 6 : distanceKm <= 5 ? 4 : 0;
  return { total: type + bedrooms + bathrooms + cars + area + location, breakdown: { type, bedrooms, bathrooms, cars, area, location } };
}

async function referenceCoordinates(propertyId: string, location: JsonRecord) {
  const direct = coordinates(location);
  if (direct) return direct;
  const streetId = number(record(location.street).id) ?? number(findValue(location, ["streetId"]));
  if (!streetId) return null;
  const firstPage = await corelogicRequest(`/search/au/property/street/${streetId}?page=0`, { ttlSeconds: 600 });
  if (!firstPage.ok) return null;
  const pages = Math.min(Math.max(1, number(record(record(firstPage.data).page).totalPages) ?? 1), 25);
  for (let page = 0; page < pages; page += 1) {
    const result = page === 0 ? firstPage : await corelogicRequest(`/search/au/property/street/${streetId}?page=${page}`, { ttlSeconds: 600 });
    if (!result.ok) continue;
    const matching = candidateRecords(result.data).find((item) => number(item.id ?? item.propertyId) === Number(propertyId));
    if (matching) return coordinates(matching);
  }
  return null;
}

export async function GET(_request: Request, context: RouteContext<"/api/corelogic/properties/[id]/comparables">) {
  const { id } = await context.params;
  if (!/^\d{1,14}$/.test(id)) return Response.json({ detail: "Invalid CoreLogic property identifier." }, { status: 400 });

  const [coreResponse, additionalResponse, locationResponse] = await Promise.all([
    corelogicRequest(`/property-details/au/properties/${id}/attributes/core`, { ttlSeconds: 300 }),
    corelogicRequest(`/property-details/au/properties/${id}/attributes/additional`, { ttlSeconds: 300 }),
    corelogicRequest(`/property-details/au/properties/${id}/location`, { ttlSeconds: 300 }),
  ]);
  if (!coreResponse.ok || !locationResponse.ok) {
    return Response.json({ detail: "The reference property could not be loaded for comparison." }, { status: 502 });
  }

  const core = record(coreResponse.data);
  const additional = record(additionalResponse.data);
  const location = record(locationResponse.data);
  const localityId = number(record(location.locality).id) ?? number(findValue(location, ["localityId"]));
  if (!localityId) return Response.json({ detail: "Cotality did not return a locality identifier for this property." }, { status: 404 });

  const referenceCoordinate = await referenceCoordinates(id, location);
  const [saleResponse, rentResponse] = await Promise.all([
    corelogicRequest(`/search/au/property/locality/${localityId}/otmForSale`, { ttlSeconds: 300 }),
    corelogicRequest(`/search/au/property/locality/${localityId}/otmForRent`, { ttlSeconds: 300 }),
  ]);
  const candidateById = new Map<number, JsonRecord>();
  // Rental candidates are added first so rent-bearing matches are preferred when
  // otherwise-identical summary scores tie. A sale record may supplement it.
  for (const item of [...(rentResponse.ok ? candidateRecords(rentResponse.data) : []), ...(saleResponse.ok ? candidateRecords(saleResponse.data) : [])]) {
    const candidateId = number(item.id ?? item.propertyId);
    if (candidateId === null || candidateId === Number(id)) continue;
    candidateById.set(candidateId, { ...item, ...(candidateById.get(candidateId) || {}) });
  }
  const sourceCandidates = Array.from(candidateById.values()).slice(0, 50);

  const reference = {
    propertyType: string(core.propertyType), beds: number(core.beds), baths: number(core.baths), carSpaces: number(core.carSpaces),
    floorArea: number(additional.floorArea), landArea: number(core.landArea), localityId,
  };
  const preselected = sourceCandidates
    .map((item) => {
      const attributes = record(item.attributes);
      const candidate = { propertyType: string(item.propertyType ?? attributes.propertyType), beds: number(attributes.beds ?? attributes.bedrooms ?? item.beds ?? item.bedrooms), baths: number(attributes.baths ?? attributes.bathrooms ?? item.baths ?? item.bathrooms), carSpaces: number(attributes.carSpaces ?? item.carSpaces), floorArea: number(attributes.floorArea), landArea: number(attributes.landArea ?? item.landArea), localityId, distanceKm: null };
      return { item, candidate, score: scoreCandidate(reference, candidate).total };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, 12);

  const enriched = await Promise.all(preselected.map(async ({ item }) => {
    const candidateId = number(item.id ?? item.propertyId)!;
    const [candidateCoreResponse, candidateAdditionalResponse, candidateLocationResponse] = await Promise.all([
      corelogicRequest(`/property-details/au/properties/${candidateId}/attributes/core`, { ttlSeconds: 300 }),
      corelogicRequest(`/property-details/au/properties/${candidateId}/attributes/additional`, { ttlSeconds: 300 }),
      corelogicRequest(`/property-details/au/properties/${candidateId}/location`, { ttlSeconds: 300 }),
    ]);
    const candidateCore = record(candidateCoreResponse.data);
    const candidateAdditional = record(candidateAdditionalResponse.data);
    const candidateLocation = record(candidateLocationResponse.data);
    const candidateCoordinate = coordinates(candidateLocation) ?? coordinates(item);
    const distanceKm = referenceCoordinate && candidateCoordinate ? haversineKm(referenceCoordinate, candidateCoordinate) : null;
    const candidate = {
      propertyType: string(candidateCore.propertyType) ?? string(item.propertyType), beds: number(candidateCore.beds), baths: number(candidateCore.baths), carSpaces: number(candidateCore.carSpaces),
      floorArea: number(candidateAdditional.floorArea), landArea: number(candidateCore.landArea), localityId: number(record(candidateLocation.locality).id) ?? number(findValue(candidateLocation, ["localityId"])) ?? localityId, distanceKm,
    };
    const score = scoreCandidate(reference, candidate);
    const image = record(item.propertyPhoto);
    const rentalCampaign = record(item.otmForRentDetail);
    const weeklyRent = number(rentalCampaign.price);
    const rentPeriod = string(rentalCampaign.period) ?? "W";
    return {
      propertyId: candidateId,
      address: string(findValue(candidateLocation, ["singleLine", "displayAddress"])) ?? string(findValue(item, ["singleLine", "displayAddress", "address"])) ?? `Property ${candidateId}`,
      imageUrl: string(image.largePhotoUrl ?? image.mediumPhotoUrl ?? image.thumbnailPhotoUrl),
      campaign: string(findValue(item, ["priceDescription", "advertisedPrice", "displayPrice"])),
      weeklyRent: weeklyRent !== null && rentPeriod === "W" ? weeklyRent : null,
      rentPeriod,
      rentDescription: string(rentalCampaign.priceDescription),
      ...candidate,
      score,
    };
  }));

  const candidates = enriched.sort((left, right) => right.score.total - left.score.total || (left.distanceKm ?? Infinity) - (right.distanceKm ?? Infinity));
  return Response.json({
    reference: { propertyId: Number(id), coordinateAvailable: Boolean(referenceCoordinate), ...reference },
    candidatePool: { localityId, forSale: saleResponse.ok, forRent: rentResponse.ok, discovered: sourceCandidates.length, enriched: candidates.length },
    candidates,
    cache: { ttlSeconds: 300 },
  }, { headers: { "Cache-Control": "private, max-age=60, stale-while-revalidate=300" } });
}
