/**
 * Isomorphic Parcel Atlas report builder.
 *
 * Shared by the browser component and the scheduled worker so both produce byte-
 * identical HTML. Image embedding is injected because the browser fetches
 * through the image proxy route while the worker fetches Cotality directly.
 *
 * Must stay free of `server-only`, `node:*` and DOM imports.
 */

export type JsonRecord = Record<string, unknown>;
export type ReportCandidate = JsonRecord;

/** Resolves an image URL to a data URI, or "" when unavailable. */
export type ImageEmbedder = (sources: Array<string | null | undefined>) => Promise<Map<string, string>>;

export const MIN_COMPARABLE_SCORE = 60;
const MIN_PLAUSIBLE_WEEKLY_RENT = 100;
const MAX_PLAUSIBLE_WEEKLY_RENT = 25_000;

export function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "—").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character] || character,
  );
}

/** Normalises an address for exact-match comparison. */
export function comparableAddress(value: string): string {
  return value
    .toUpperCase()
    .replace(/\bST\b/g, "STREET")
    .replace(/\bRD\b/g, "ROAD")
    .replace(/\bAVE\b/g, "AVENUE")
    .replace(/\bCT\b/g, "COURT")
    .replace(/\bDR\b/g, "DRIVE")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

export function findValue(value: unknown, names: string[]): unknown {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
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

export function formatMoney(value: unknown): string {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number)
    ? new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(number)
    : "Not available";
}

function median(values: number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

/**
 * Applies the report quality rules: score threshold, confirmed weekly rent, and
 * market-outlier exclusion. Returns the included and excluded candidate sets.
 */
export function selectQualityComparableRents(candidates: ReportCandidate[]): {
  selected: ReportCandidate[];
  excluded: ReportCandidate[];
} {
  const scoreEligible = candidates.filter(
    (candidate) => Number(record(candidate.score).total) >= MIN_COMPARABLE_SCORE,
  );
  const hardValid = scoreEligible.filter((candidate) => {
    const rent = Number(candidate.weeklyRent);
    return Number.isFinite(rent) && rent >= MIN_PLAUSIBLE_WEEKLY_RENT && rent <= MAX_PLAUSIBLE_WEEKLY_RENT;
  });
  const excluded = scoreEligible.filter((candidate) => !hardValid.includes(candidate));
  let selected = hardValid;

  if (hardValid.length >= 3) {
    const marketMedian = median(hardValid.map((candidate) => Number(candidate.weeklyRent)));
    const lowerBound = Math.max(MIN_PLAUSIBLE_WEEKLY_RENT, marketMedian * 0.35);
    const upperBound = Math.min(MAX_PLAUSIBLE_WEEKLY_RENT, marketMedian * 3);
    selected = hardValid.filter((candidate) => {
      const rent = Number(candidate.weeklyRent);
      return rent >= lowerBound && rent <= upperBound;
    });
    excluded.push(...hardValid.filter((candidate) => !selected.includes(candidate)));
  }

  return { selected: selected.slice(0, 12), excluded };
}

export function averageWeeklyRentOf(candidates: ReportCandidate[]): number | null {
  if (!candidates.length) return null;
  return candidates.reduce((sum, candidate) => sum + Number(candidate.weeklyRent), 0) / candidates.length;
}

const REPORT_STYLE =
  "<style>@page{size:A4;margin:10mm}body{background:#f4f1e8;color:#172022;font-family:Arial,sans-serif;margin:0}.wrap{margin:auto;max-width:1080px;padding:48px}header{background:#172022;color:white;padding:42px}.hero-image{display:block;max-height:480px;object-fit:cover;width:100%}h1{font-family:Georgia,serif;font-size:44px;font-weight:400;letter-spacing:-.04em;margin:12px 0}.tag{color:#d7ff45;font-size:11px;letter-spacing:.15em;text-transform:uppercase}.facts{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;margin:30px 0}.facts div{background:white;padding:20px}.facts span{color:#667070;font-size:10px;text-transform:uppercase}.facts strong{display:block;font-family:Georgia,serif;font-size:23px;font-weight:400;line-height:1.1;margin-top:8px}h2{font-family:Georgia,serif;font-size:34px;font-weight:400;margin:46px 0 11px}.note{background:#e8f8d0;border-left:4px solid #7c9c26;line-height:1.5;margin-top:25px;padding:17px}.source{color:#667070;font-size:11px;line-height:1.5}.quality-note{background:#fff0c7;border-left:4px solid #d69c1d;color:#5f4a18;font-size:11px;line-height:1.5;margin:14px 0 0;padding:12px 14px}.rent-summary{background:#172022;color:white;display:flex;justify-content:space-between;margin-top:23px;padding:21px 24px}.rent-summary span,.rent-summary small{color:rgba(255,255,255,.55);font-size:9px;letter-spacing:.1em;text-transform:uppercase}.rent-summary strong{color:#d7ff45;font-family:Georgia,serif;font-size:34px;font-weight:400}.rent-summary div:last-child{text-align:right}.comp-grid{display:grid;gap:1px;margin-top:24px}.comp-card{background:white;display:grid;grid-template-columns:92px 190px minmax(240px,1fr) 210px;min-height:168px}.comp-rank{background:#172022;color:white;display:flex;flex-direction:column;justify-content:center;padding:18px}.comp-rank span,.comp-distance span,.micro{font-size:9px;letter-spacing:.1em;text-transform:uppercase}.comp-rank span{color:#8ce4dd}.comp-rank strong{color:#d7ff45;font-family:Georgia,serif;font-size:39px;font-weight:400;line-height:1;margin-top:11px}.comp-rank small{color:rgba(255,255,255,.5);font-size:10px;margin-top:2px}.comp-image{background:#293335;min-height:168px}.comp-image img{height:100%;object-fit:cover;width:100%}.image-fallback{align-items:center;color:#8ce4dd;display:flex;font-size:11px;height:100%;justify-content:center}.comp-copy{padding:23px 25px}.micro{color:#ff6940}.comp-copy h3{font-family:Georgia,serif;font-size:21px;font-weight:400;line-height:1.1;margin:10px 0 7px}.comp-copy p{color:#667070;font-size:11px;line-height:1.45;margin:0}.score-line{border-top:1px solid #ddd9cf;color:#667070;font-size:9px;line-height:1.45;margin-top:15px;padding-top:9px}.comp-distance{background:#e5f7d0;display:flex;flex-direction:column;justify-content:center;padding:20px}.comp-distance span{color:#657f1d}.comp-distance strong{font-family:Georgia,serif;font-size:20px;font-weight:400;line-height:1.15;margin-top:10px}.comp-distance small{color:#526043;font-size:10px;line-height:1.4;margin-top:8px}@media(max-width:720px){.wrap{padding:20px}.facts{grid-template-columns:repeat(2,1fr)}.rent-summary{display:block}.rent-summary div:last-child{text-align:left;margin-top:12px}.comp-card{grid-template-columns:70px 115px 1fr}.comp-distance{grid-column:2/-1}.comp-image{min-height:130px}}@media print{body{background:white}.wrap{max-width:none;padding:0}header{padding:20px 24px}.facts{margin:18px 0}.comp-card{break-inside:avoid}.comp-grid{gap:8px}.note{break-inside:avoid}}</style></head><body>";

/**
 * Builds the self-contained HTML report from a Cotality property dossier and
 * comparables payload.
 */
export async function buildReportHtml(input: {
  address: string;
  profile: unknown;
  comparables: unknown;
  embedImages?: ImageEmbedder;
  now?: Date;
}): Promise<string> {
  const property = record(input.profile);
  const modules = record(property.modules);
  const core = record(record(modules.core).data);
  const additional = record(record(modules.additional).data);
  const location = record(record(modules.location).data);
  const lastSale = record(record(modules.lastSale).data);
  const imageData = record(record(modules.images).data);
  const locality = record(location.locality);
  const reference = record(record(input.comparables).reference);
  const image = record(imageData.defaultImage);
  const imageUrl =
    typeof image.largePhotoUrl === "string"
      ? image.largePhotoUrl
      : typeof image.mediumPhotoUrl === "string"
        ? image.mediumPhotoUrl
        : "";

  const avm = formatMoney(
    findValue(record(modules.avm).data, [
      "estimate",
      "avmEstimate",
      "consumerAvmEstimate",
      "estimatedValue",
      "value",
      "amount",
    ]),
  );
  const rentalAvm = formatMoney(
    findValue(record(modules.rentalAvm).data, ["rentalAvmEstimate", "estimate", "estimatedRent", "rent", "amount"]),
  );
  const salePrice = formatMoney(findValue(lastSale, ["price", "salePrice", "saleAmount", "amount"]));
  const saleDate = findValue(lastSale, ["date", "saleDate", "contractDate", "settlementDate"]);

  const candidates = Array.isArray(record(input.comparables).candidates)
    ? (record(input.comparables).candidates as ReportCandidate[])
    : [];
  const rentQuality = selectQualityComparableRents(candidates);
  const qualifiedCandidates = rentQuality.selected;
  const averageWeeklyRent = averageWeeklyRentOf(qualifiedCandidates);
  const excludedRentNote = rentQuality.excluded.length
    ? `<p class='quality-note'>Rent-quality check excluded ${rentQuality.excluded.length} comparable${rentQuality.excluded.length === 1 ? "" : "s"} with a missing, implausible, or market-outlier weekly rent before the average was calculated.</p>`
    : "";

  const embedded = input.embedImages
    ? await input.embedImages([
        imageUrl,
        ...qualifiedCandidates.map((candidate) => (typeof candidate.imageUrl === "string" ? candidate.imageUrl : null)),
      ])
    : new Map<string, string>();
  const heroImage = imageUrl ? embedded.get(String(imageUrl)) || "" : "";

  const candidateRows = qualifiedCandidates
    .map((candidate, index) => {
      const score = record(candidate.score);
      const breakdown = record(score.breakdown);
      const locationText =
        candidate.distanceKm === null
          ? "Distance unavailable · same locality #" + String(candidate.localityId || "—")
          : String(candidate.distanceKm) + " km from reference";
      const breakdownText =
        "Type " + (breakdown.type || 0) +
        " · Beds " + (breakdown.bedrooms || 0) +
        " · Baths " + (breakdown.bathrooms || 0) +
        " · Cars " + (breakdown.cars || 0) +
        " · Area " + (breakdown.area || 0) +
        " · Location " + (breakdown.location || 0);
      const area = candidate.floorArea
        ? String(candidate.floorArea) + " m² floor"
        : candidate.landArea
          ? String(candidate.landArea) + " m² land"
          : "Area unavailable";
      const candidateImageSource = typeof candidate.imageUrl === "string" ? embedded.get(candidate.imageUrl) || "" : "";
      const candidateImage = candidateImageSource
        ? "<img src='" + escapeHtml(candidateImageSource) + "' alt='" + escapeHtml(candidate.address) + "'>"
        : "<div class='image-fallback'>Image unavailable</div>";
      return (
        "<article class='comp-card'><div class='comp-rank'><span>Match</span><strong>" +
        escapeHtml(score.total) +
        "</strong><small>/ 100</small></div><div class='comp-image'>" +
        candidateImage +
        "</div><div class='comp-copy'><span class='micro'>Comparable " +
        String(index + 1).padStart(2, "0") +
        " · Property ID " +
        escapeHtml(candidate.propertyId) +
        "</span><h3>" +
        escapeHtml(candidate.address) +
        "</h3><p>" +
        escapeHtml(candidate.propertyType) +
        " · " +
        escapeHtml(candidate.beds) +
        " bed · " +
        escapeHtml(candidate.baths) +
        " bath · " +
        escapeHtml(candidate.carSpaces) +
        " car · " +
        area +
        "</p><div class='score-line'>" +
        escapeHtml(breakdownText) +
        "</div></div><div class='comp-distance'><span>Distance from reference</span><strong>" +
        escapeHtml(locationText) +
        "</strong><small>Weekly rent: " +
        escapeHtml(formatMoney(candidate.weeklyRent)) +
        " / week</small></div></article>"
      );
    })
    .join("");

  const fact = (label: string, value: unknown) =>
    "<div><span>" + label + "</span><strong>" + escapeHtml(value) + "</strong></div>";
  const moduleCount = Object.keys(modules).length;
  const distanceNote =
    reference.coordinateAvailable === true
      ? "Distance is calculated from reference and candidate latitude/longitude with the Haversine formula."
      : "The reference property has no usable coordinate from Cotality, so distance is not invented. Each candidate receives the exact-locality fallback score instead.";

  return [
    "<!doctype html><html lang='en'><head><meta charset='utf-8'><title>",
    escapeHtml(input.address),
    " — Parcel Atlas report</title>",
    REPORT_STYLE,
    "<header class='wrap'><div class='tag'>Parcel Atlas / Property report</div><h1>",
    escapeHtml(location.singleLine || input.address),
    "</h1><p>Generated ",
    (input.now ?? new Date()).toLocaleString("en-AU"),
    " · CoreLogic/Cotality evidence</p></header>",
    heroImage ? "<img class='hero-image' src='" + escapeHtml(heroImage) + "' alt='Property image'>" : "",
    "<main class='wrap'><div class='facts'>",
    fact("Type", core.propertyType),
    fact("Bedrooms", core.beds),
    fact("Bathrooms", core.baths),
    fact("Car spaces", core.carSpaces),
    fact("Land area", String(core.landArea || "—") + " m²"),
    fact("Floor area", String(additional.floorArea || "—") + " m²"),
    fact("Locality", locality.singleLine),
    fact("Locality ID", locality.id),
    fact("Council", location.councilArea),
    fact("Property ID", property.propertyId),
    fact("Consumer AVM", avm),
    fact("Rental AVM", rentalAvm),
    fact("Last sale", salePrice),
    fact("Sale date", saleDate),
    fact("Data modules", moduleCount),
    "</div>",
    "<h2>Similar homes</h2><p>The candidate pool is sourced from the exact CoreLogic locality, then enriched and ranked using the configured 100-point property-similarity score. Only matches scoring 60/100 or above with confirmed weekly rental data are included in this report.</p>",
    averageWeeklyRent === null
      ? ""
      : "<div class='rent-summary'><div><span>Average weekly rent</span><strong>" +
        escapeHtml(formatMoney(averageWeeklyRent)) +
        " / week</strong></div><div><small>Calculated from " +
        qualifiedCandidates.length +
        " qualifying comparable" +
        (qualifiedCandidates.length === 1 ? "" : "s") +
        "</small></div></div>",
    excludedRentNote,
    "<div class='comp-grid'>",
    candidateRows || "<p>No comparable properties met the score and rent-quality requirements.</p>",
    "</div><div class='note'><strong>Distance handling:</strong> ",
    distanceNote,
    "<br><br><strong>Comparable inclusion rule:</strong> score ≥ 60 / 100, confirmed weekly rent, and rent-quality validation · <strong>Score weights:</strong> type 35 · bedrooms 20 · bathrooms 15 · car spaces 10 · floor/land area 10 · locality or distance 10.</div><p class='source'>Source coverage: ",
    moduleCount,
    " connected Cotality response modules were included when this report was generated. Estimates, advertisements and registered sales are different evidence types and should not be treated as interchangeable.</p></main></body></html>",
  ].join("");
}

export function reportFilenameFor(propertyId: number | string): string {
  return `parcel-atlas-${propertyId}.html`;
}
