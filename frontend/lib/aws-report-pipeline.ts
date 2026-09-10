/** Direct Cotality report pipeline for the AWS worker; it never calls Vercel. */
import { corelogicPost, corelogicRequest } from "./corelogic";
import { buildReportPdf } from "./report-pdf";
import { comparableAddress, record } from "./report-html";
import { loadSearchReference, referenceModules } from "./search-reference";
import type { MatchOutcome } from "./report-pipeline";

const asRecord = (value: unknown) => record(value);
const num = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : null;
const str = (value: unknown) => typeof value === "string" && value.trim() ? value : null;

export async function matchAddressDirect(address: string): Promise<MatchOutcome> {
  const [matcher, suggest] = await Promise.all([
    corelogicRequest(`/search/au/matcher/address?q=${encodeURIComponent(address)}&clientName=Parcel%20Atlas`),
    corelogicRequest(`/property/au/v2/suggest.json?q=${encodeURIComponent(address)}`),
  ]);
  if (!matcher.ok && !suggest.ok) throw new Error(`Cotality address search failed (${matcher.status}/${suggest.status}).`);
  const rawSuggestions = asRecord(suggest.data).suggestions;
  const suggestions: Record<string, unknown>[] = Array.isArray(rawSuggestions) ? rawSuggestions.map(asRecord) : [];
  const details = asRecord(matcher.data).matchDetails;
  const exactId = num(asRecord(details).propertyId);
  if (asRecord(details).matchType === "E" && exactId) {
    const item = suggestions.find((value) => num(value.propertyId) === exactId);
    return { kind: "exact", propertyId: exactId, normalizedAddress: str(item?.suggestion) ?? address };
  }
  const exact = suggestions.find((item) => comparableAddress(str(item.suggestion) ?? "") === comparableAddress(address));
  if (exact && num(exact.propertyId)) return { kind: "exact", propertyId: num(exact.propertyId)!, normalizedAddress: str(exact.suggestion) ?? address };
  return suggestions.length ? { kind: "needs_review", reason: "No exact Cotality address match." } : { kind: "unmatched", reason: "No Cotality property candidate found." };
}

export async function generatePropertyPdfDirect(params: { propertyId: number; address: string }) {
  const summary = await loadSearchReference(String(params.propertyId), params.address);
  const modules = referenceModules(summary);
  const profile = { propertyId: params.propertyId, scope: "overview", modules };
  const ref = { propertyId: params.propertyId, ...asRecord(modules.core.data), ...asRecord(modules.additional.data), localityId: asRecord(modules.location.data).locality ? asRecord(asRecord(modules.location.data).locality).id : null };
  const response = await corelogicPost("/property/au/v1/property/comparables.json", { propertyId: params.propertyId, comparablesRuleId: 3, returnDetailForComparableCategoryId: ["1","2","3","4","5"], returnStatisticsForComparableCategoryId: ["1","2","3","4","5"], limit: 24, returnFields: ["address","attributes"] });
  if (!response.ok) throw new Error(`Cotality rental comparables failed (${response.status}).`);
  const candidates: Record<string, unknown>[] = [];
  const rawGroups = asRecord(response.data).comparablesSummaryList;
  const groups: unknown[] = Array.isArray(rawGroups) ? rawGroups : [];
  for (const group of groups) { const rawItems = asRecord(group).propertyComparableList; for (const item of (Array.isArray(rawItems) ? rawItems : [])) {
    const source=asRecord(item), property=asRecord(source.property), attrs=asRecord(property.attributes), campaign=asRecord(source.comparableForRentPropertyCampaign), photos=Array.isArray(property.propertyPhotoList)?property.propertyPhotoList:[];
    const photo=asRecord(photos[0]); const period=str(campaign.period)??""; const price=num(campaign.price);
    candidates.push({propertyId:num(property.id),address:str(asRecord(property.address).singleLine)??"",imageUrl:str(photo.largePhotoUrl??photo.mediumPhotoUrl??photo.thumbnailPhotoUrl),weeklyRent:price && /W|WEEK/i.test(period)?price:null,rentPeriod:period,rentDescription:str(campaign.priceDescription),propertyType:str(property.propertyType),beds:num(attrs.bedrooms),baths:num(attrs.bathrooms),carSpaces:num(attrs.carSpaces),floorArea:num(attrs.floorArea),landArea:num(attrs.landArea),distanceKm:num(source.distanceFromTarget),score:{total:0}});
  }}
  const comparables={reference:ref,candidates};
  return buildReportPdf({ address: params.address, profile, comparables, embedImages: async (sources) => {
    const entries: Array<[string, string]> = [];
    for (const source of [...new Set(sources.filter((s): s is string => Boolean(s)))].slice(0, 13)) try { const r = await fetch(source, { signal: AbortSignal.timeout(15_000) }); if (r.ok) entries.push([source, `data:${r.headers.get("content-type") ?? "image/jpeg"};base64,${Buffer.from(await r.arrayBuffer()).toString("base64")}`]); } catch { /* image optional */ }
    return new Map(entries);
  } });
}
