import { corelogicRequest } from './corelogic';
import { record } from './report-html';

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
  const suggestion = await corelogicRequest('/property/au/v2/suggest.json?q=' + encodeURIComponent(address.slice(0, 160)));
  if (!suggestion.ok) throw new Error('Cotality address discovery failed (HTTP ' + suggestion.status + ').');
  const items = record(suggestion.data).suggestions;
  const matched = Array.isArray(items) ? items.map(record).find(item => Number(item.propertyId) === Number(id)) : undefined;
  if (!matched) throw new Error('Search did not resolve the requested property ID for this address.');
  const streetId = Number(matched.streetId);
  if (!Number.isSafeInteger(streetId) || streetId <= 0) throw new Error('Search did not provide a street ID for this property.');
  for (let page = 0; page < 25; page++) {
    const result = await corelogicRequest('/search/au/property/street/' + streetId + '?page=' + page);
    if (!result.ok) throw new Error('Cotality street search failed (HTTP ' + result.status + ').');
    const summary = searchSummaries(result.data).find(item => Number(item.id) === Number(id));
    if (summary) return summary;
    const total = Number(record(record(result.data).page).totalPages);
    if (!Number.isFinite(total) || page + 1 >= total) break;
  }
  throw new Error('The exact reference property was not found within the bounded street search.');
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
