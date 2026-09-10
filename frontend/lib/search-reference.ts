import { corelogicRequest } from './corelogic';
import { record } from './report-html';

/**
 * Ceiling on street pages scanned for one property.
 *
 * Deliberately small. `corelogic.ts` serialises every Cotality call with a
 * 500 ms floor, so this bound is a *request budget per address*, not a free
 * parallel scan: 20 pages is already ~10 seconds of sustained calls. A previous
 * value of 150 caused sandbox rate-limit exhaustion on a single dense street,
 * which is why the direct property lookup below exists.
 */
export const MAX_STREET_PAGES = clampEnv("COTALITY_MAX_STREET_PAGES", 20, 1, 40);

/**
 * Pages requested per batch. Capped hard: the shared queue serialises requests
 * anyway, so a large batch buys no speed and only deepens a burst.
 */
export const STREET_PAGE_BATCH = clampEnv("COTALITY_STREET_PAGE_CONCURRENCY", 4, 1, 8);

function clampEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed < minimum) return fallback;
  // An oversized override must not be able to reintroduce a burst.
  return Math.min(Math.floor(parsed), maximum);
}

/**
 * Resolves one property in a single request.
 *
 * `/property/au/v1/property/{id}.json` returns the property directly, which
 * removes the need to page an entire street to locate a known id. Verified
 * against 81 Grima Street Schofields, a 2,238-property complex where the target
 * sat on page 100 of 112: this endpoint answered in one call while the paged
 * scan returned HTTP 429.
 *
 * Returns null when the payload lacks the fields the report needs, so the
 * caller can fall back rather than build a report from a partial record.
 */
async function loadDirectSummary(id: string): Promise<Record<string, unknown> | null> {
  const response = await corelogicRequest(`/property/au/v1/property/${encodeURIComponent(id)}.json`, { ttlSeconds: 900 });
  if (!response.ok) return null;

  const property = record(record(response.data).property);
  if (Number(property.id) !== Number(id)) return null;

  const attributes = record(property.attributes);
  const address = record(property.address);
  const photos = property.propertyPhotoList;
  const photo = Array.isArray(photos)
    ? record(photos.find((item) => record(item).isDefaultPhoto === true) ?? photos[0])
    : record(property.propertyPhoto);

  // The street-search shape is what referenceModules() expects, so the direct
  // payload is normalised into it rather than changing every consumer.
  const summary: Record<string, unknown> = {
    id: Number(property.id),
    propertyType: property.propertyType ?? property.propertySubType ?? null,
    attributes: {
      bedrooms: attributes.bedrooms ?? attributes.beds ?? null,
      bathrooms: attributes.bathrooms ?? attributes.baths ?? null,
      carSpaces: attributes.carSpaces ?? attributes.lockUpGarages ?? null,
      landArea: attributes.landArea ?? null,
      floorArea: attributes.floorArea ?? attributes.livingArea ?? null,
      yearBuilt: attributes.yearBuilt ?? null,
    },
    address: {
      singleLineAddress: address.singleLine ?? address.singleLineAddress ?? null,
      councilArea: address.councilArea ?? null,
    },
    locationIdentifiers: {
      localityId: record(record(address.street).locality).id ?? record(address.locality).id ?? null,
      streetId: record(address.street).id ?? null,
    },
    coordinate: property.coordinate ?? null,
    propertyPhoto: photo,
  };

  // A property type is the minimum needed for similarity scoring; without it
  // the paged path is still worth trying.
  return summary.propertyType ? summary : null;
}

export function searchSummaries(payload: unknown): Record<string, unknown>[] {
  const list = record(record(payload)._embedded).propertySummaryList;
  return Array.isArray(list) ? list.map(item => record(record(item).propertySummary)) : [];
}

/**
 * Resolves an exact property summary through the public Search services.
 * Matching the property ID after address suggestion avoids attaching a photo
 * from another unit or similarly named street.
 */
export async function loadSearchSummary(id: string, address: string) {
  if (!address.trim()) throw new Error('The reference address is required to load Search configuration. Re-select the property and retry.');

  // One request instead of up to a hundred. Tried first because paging a dense
  // street is what exhausted the Cotality rate limit previously.
  const direct = await loadDirectSummary(id);
  if (direct) return direct;

  const suggestion = await corelogicRequest('/property/au/v2/suggest.json?q=' + encodeURIComponent(address.slice(0, 160)));
  if (!suggestion.ok) throw new Error('Cotality address discovery failed (HTTP ' + suggestion.status + ').');
  const items = record(suggestion.data).suggestions;
  const matched = Array.isArray(items) ? items.map(record).find(item => Number(item.propertyId) === Number(id)) : undefined;
  if (!matched) throw new Error('Search did not resolve the requested property ID for this address.');
  const streetId = Number(matched.streetId);
  if (!Number.isSafeInteger(streetId) || streetId <= 0) throw new Error('Search did not provide a street ID for this property.');
  const first = await corelogicRequest('/search/au/property/street/' + streetId + '?page=0');
  if (!first.ok) throw new Error('Cotality street search failed (HTTP ' + first.status + ').');
  const firstMatch = searchSummaries(first.data).find(item => Number(item.id) === Number(id));
  if (firstMatch) return firstMatch;

  // Large apartment complexes are genuinely deep: 81 Grima Street Schofields is
  // 2,238 properties over 112 pages, and unit 438 sits on page 100. A 75-page
  // cap silently excluded it, so the bound now follows the street's real page
  // count up to a hard ceiling that still prevents an unbounded scan.
  const totalPages = Number(record(record(first.data).page).totalPages);
  const pageLimit = Number.isFinite(totalPages) && totalPages > 0
    ? Math.min(Math.floor(totalPages), MAX_STREET_PAGES)
    : 25;

  for (let start = 1; start < pageLimit; start += STREET_PAGE_BATCH) {
    const pages = Array.from(
      { length: Math.min(STREET_PAGE_BATCH, pageLimit - start) },
      (_, index) => start + index,
    );
    const results = await Promise.all(pages.map(async (page) => {
      const result = await corelogicRequest('/search/au/property/street/' + streetId + '?page=' + page);
      if (!result.ok) throw new Error('Cotality street search failed (HTTP ' + result.status + ').');
      return result.data;
    }));
    for (const data of results) {
      const summary = searchSummaries(data).find(item => Number(item.id) === Number(id));
      if (summary) return summary;
    }
  }

  // Report the bound that was actually applied: "not found" alone reads as if
  // the property does not exist, when it may simply sit beyond the ceiling.
  throw new Error(
    `The exact reference property was not found in the first ${pageLimit} of ${Number.isFinite(totalPages) ? totalPages : "unknown"} street pages (street ${streetId}, property ${id}).`,
  );
}

export const loadSearchReference = loadSearchSummary;

export function referenceModules(summary: Record<string, unknown>) {
  const attrs = record(summary.attributes);
  const location = record(summary.locationIdentifiers);
  const address = record(summary.address);
  const photo = record(summary.propertyPhoto);
  const wrap = <T>(data: T) => ({ ok: true, status: 200, data, cacheStatus: 'MISS' });
  return {
    core: wrap({ propertyType: summary.propertyType ?? null, beds: attrs.bedrooms ?? null, baths: attrs.bathrooms ?? null, carSpaces: attrs.carSpaces ?? null, landArea: attrs.landArea ?? null }),
    additional: wrap({ floorArea: attrs.floorArea ?? attrs.livingArea ?? null, yearBuilt: attrs.yearBuilt ?? null }),
    location: wrap({ singleLine: address.singleLineAddress ?? address.singleLine ?? null, coordinate: summary.coordinate, locality: { id: location.localityId ?? null }, street: { id: location.streetId ?? null }, councilArea: address.councilArea ?? null }),
    images: wrap({ defaultImage: photo }),
  };
}
