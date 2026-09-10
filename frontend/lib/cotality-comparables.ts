/**
 * Shared Cotality rental-comparables mapping and similarity scoring.
 *
 * Single source of truth for the Vercel API route and the AWS report Lambda, so
 * a scoring change cannot apply to one and not the other. Deliberately free of
 * `server-only`, Next.js and AWS imports: it must bundle into Lambda and be
 * unit testable in plain Node.
 *
 * Cotality access itself stays in `corelogic.ts`, which owns credentials,
 * throttling and retries. This module only interprets responses.
 */

export type JsonRecord = Record<string, unknown>;
export type Coordinate = { latitude: number; longitude: number };

/** Cotality's rental-listing comparables rule. */
export const RENTAL_COMPARABLES_RULE_ID = 3;
/** Minimum candidates to show when that many rental comparables exist. */
export const MINIMUM_REPORT_CANDIDATES = 5;
/** Bounded concurrency for candidate image lookups. */
export const IMAGE_ENRICHMENT_CONCURRENCY = 3;

export function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

export function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.trim() && Number.isFinite(Number(value))
      ? Number(value)
      : null;
}

export function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function coordinate(value: unknown): Coordinate | null {
  const source = record(value);
  const latitude = number(source.latitude);
  const longitude = number(source.longitude);
  return latitude === null || longitude === null ? null : { latitude, longitude };
}

export function haversineKm(first: Coordinate, second: Coordinate): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(second.latitude - first.latitude);
  const longitudeDelta = radians(second.longitude - first.longitude);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(first.latitude)) * Math.cos(radians(second.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return Math.round(2 * 6371 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 100) / 100;
}

/**
 * Exact match scores `exact`, a difference of one scores `close`, anything else
 * zero. A missing value on either side scores zero rather than being treated as
 * a match, so absent data never manufactures similarity.
 */
export function scoreDifference(
  reference: number | null,
  candidate: number | null,
  exact: number,
  close: number,
): number {
  if (reference === null || candidate === null) return 0;
  if (reference === candidate) return exact;
  return Math.abs(reference - candidate) === 1 ? close : 0;
}

export type ScoreBreakdown = {
  type: number;
  bedrooms: number;
  bathrooms: number;
  cars: number;
  area: number;
  location: number;
};

export type CandidateScore = { total: number; breakdown: ScoreBreakdown };

/**
 * 100-point similarity score: type 35, bedrooms 20, bathrooms 15, cars 10,
 * area 10, location 10.
 */
export function scoreCandidate(reference: JsonRecord, candidate: JsonRecord): CandidateScore {
  const referenceType = string(reference.propertyType)?.toUpperCase();
  const candidateType = string(candidate.propertyType)?.toUpperCase();
  const type = referenceType && candidateType && referenceType === candidateType ? 35 : 0;

  const bedrooms = scoreDifference(number(reference.beds), number(candidate.beds), 20, 10);
  const bathrooms = scoreDifference(number(reference.baths), number(candidate.baths), 15, 7);
  const cars = scoreDifference(number(reference.carSpaces), number(candidate.carSpaces), 10, 5);

  // Compare like with like: floor area when both have it, otherwise land area.
  const bothFloor = number(reference.floorArea) !== null && number(candidate.floorArea) !== null;
  const referenceArea = number(bothFloor ? reference.floorArea : reference.landArea);
  const candidateArea = number(bothFloor ? candidate.floorArea : candidate.landArea);
  const area =
    referenceArea !== null &&
    candidateArea !== null &&
    referenceArea > 0 &&
    Math.abs(referenceArea - candidateArea) / referenceArea <= 0.25
      ? 10
      : 0;

  const distanceKm = number(candidate.distanceKm);
  const location =
    distanceKm === null ? 0 : distanceKm <= 0.5 ? 10 : distanceKm <= 1 ? 8 : distanceKm <= 3 ? 6 : distanceKm <= 5 ? 4 : 0;

  return { total: type + bedrooms + bathrooms + cars + area + location, breakdown: { type, bedrooms, bathrooms, cars, area, location } };
}

/**
 * Weekly rent only. A monthly or annual figure is discarded rather than
 * converted, because mixing periods would corrupt the market-rent summary.
 */
export function weeklyRent(campaign: JsonRecord): number | null {
  const value = number(campaign.price);
  const period = string(campaign.period)?.toUpperCase() || "";
  return value !== null && (period === "W" || period.includes("WEEK")) ? value : null;
}

/** Request body for the rental comparables call. */
export function comparablesRequestBody(propertyId: number): JsonRecord {
  return {
    propertyId,
    comparablesRuleId: RENTAL_COMPARABLES_RULE_ID,
    returnDetailForComparableCategoryId: ["1", "2", "3", "4", "5"],
    returnStatisticsForComparableCategoryId: ["1", "2", "3", "4", "5"],
    limit: 24,
    // No targetPropertyValuation: a rent review must not fabricate a sale value.
    returnFields: ["address", "attributes"],
  };
}

/**
 * Maps a comparables payload into scored candidates.
 *
 * Excludes the reference property itself and any repeated property id, then
 * sorts by descending score and ascending distance.
 */
export function candidatesFromComparables(
  payload: unknown,
  referenceCoordinate: Coordinate | null,
  reference: JsonRecord,
): JsonRecord[] {
  const seen = new Set<number>();
  const output: JsonRecord[] = [];
  const summaries = record(payload).comparablesSummaryList;
  if (!Array.isArray(summaries)) return output;

  const referenceId = number(reference.propertyId);

  for (const summary of summaries) {
    const properties = record(summary).propertyComparableList;
    if (!Array.isArray(properties)) continue;

    for (const item of properties) {
      const source = record(item);
      const property = record(source.property);
      const propertyId = number(property.id);
      // A candidate must be a real, distinct property that is not the subject.
      if (propertyId === null || propertyId <= 0 || propertyId === referenceId || seen.has(propertyId)) continue;
      seen.add(propertyId);

      const attributes = record(property.attributes);
      const campaign = record(source.comparableForRentPropertyCampaign);
      const candidateCoordinate = coordinate(property.coordinate);
      // Prefer measured distance; fall back to Cotality's own figure.
      const distanceKm =
        referenceCoordinate && candidateCoordinate
          ? haversineKm(referenceCoordinate, candidateCoordinate)
          : number(source.distanceFromTarget);

      const photos = property.propertyPhotoList;
      const defaultPhoto = Array.isArray(photos)
        ? record(photos.find((photo) => record(photo).isDefaultPhoto === true) ?? photos[0])
        : {};

      const candidate: JsonRecord = {
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

  return output.sort(
    (left, right) =>
      Number(record(right.score).total) - Number(record(left.score).total) ||
      (number(left.distanceKm) ?? Infinity) - (number(right.distanceKm) ?? Infinity),
  );
}

/**
 * Chooses which candidates the report shows.
 *
 * Uses the quality selector first, then tops up from the highest-scoring
 * remaining candidates that have a weekly rent, so a genuinely sparse market
 * still yields a useful report. Only weekly-rent candidates are ever added,
 * because the market-rent summary is computed from this set.
 */
export function selectReportCandidates(
  candidates: JsonRecord[],
  qualitySelector: (input: JsonRecord[]) => { selected: JsonRecord[]; excluded: JsonRecord[] },
  minimum = MINIMUM_REPORT_CANDIDATES,
): JsonRecord[] {
  const selected = qualitySelector(candidates).selected;
  if (selected.length >= minimum) return selected;

  const chosen = new Set(selected.map((candidate) => number(candidate.propertyId)));
  const topUp = candidates.filter(
    (candidate) => !chosen.has(number(candidate.propertyId)) && number(candidate.weeklyRent) !== null,
  );
  return [...selected, ...topUp.slice(0, Math.max(0, minimum - selected.length))];
}

/** Weekly-rent summary for the report and email body. */
export function marketRentSummary(candidates: JsonRecord[]): {
  low: number | null;
  high: number | null;
  average: number | null;
  count: number;
} {
  const rents = candidates
    .map((candidate) => number(candidate.weeklyRent))
    .filter((rent): rent is number => rent !== null && rent > 0);
  if (!rents.length) return { low: null, high: null, average: null, count: 0 };
  return {
    low: Math.min(...rents),
    high: Math.max(...rents),
    average: Math.round(rents.reduce((total, rent) => total + rent, 0) / rents.length),
    count: rents.length,
  };
}

/**
 * Fills in missing candidate images with bounded concurrency.
 *
 * `loadSummary` must verify the property id before returning a photo, so an
 * image from a different unit can never be attached. Failures are swallowed:
 * the PDF renders its placeholder instead of losing a valid comparable.
 */
export async function enrichCandidateImages(
  candidates: JsonRecord[],
  selected: JsonRecord[],
  loadSummary: (propertyId: number, address: string) => Promise<JsonRecord>,
  concurrency = IMAGE_ENRICHMENT_CONCURRENCY,
): Promise<JsonRecord[]> {
  const queue = selected.filter(
    (candidate) => !string(candidate.imageUrl) && number(candidate.propertyId) !== null && string(candidate.address),
  );
  if (!queue.length) return candidates;

  const imageByPropertyId = new Map<number, string>();
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < queue.length) {
      const candidate = queue[cursor++];
      const propertyId = number(candidate.propertyId)!;
      try {
        const summary = await loadSummary(propertyId, string(candidate.address)!);
        const photo = record(summary.propertyPhoto);
        const imageUrl = string(photo.largePhotoUrl ?? photo.mediumPhotoUrl ?? photo.thumbnailPhotoUrl);
        if (imageUrl) imageByPropertyId.set(propertyId, imageUrl);
      } catch {
        // Enrichment is best effort; a placeholder is preferable to a lost row.
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));

  return candidates.map((candidate) => {
    const imageUrl = imageByPropertyId.get(number(candidate.propertyId) ?? -1);
    return imageUrl ? { ...candidate, imageUrl } : candidate;
  });
}
