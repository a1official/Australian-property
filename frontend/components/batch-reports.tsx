"use client";

import { ChangeEvent, useMemo, useState } from "react";
import { ArrowRight, Check, CircleDashed, FileText, LoaderCircle, Printer, Search } from "lucide-react";

type Suggestion = { propertyId: number | string; suggestion: string };
type MatchDetails = { propertyId?: number | string; matchType?: string; matchRule?: string; updateIndicator?: string };
type Status = "matching" | "ready" | "review" | "unmatched" | "processing" | "complete" | "failed";
type BatchRow = { id: string; rowNumber: number; originalAddress: string; propertyId?: number; normalizedAddress?: string; suggestions: Suggestion[]; match?: MatchDetails | null; status: Status; note: string; report?: string; error?: string };

function parseCsv(source: string) {
  const output: string[][] = [];
  let row: string[] = [], value = "", quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index], next = source[index + 1];
    if (character === '"' && quoted && next === '"') { value += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) { row.push(value.trim()); value = ""; }
    else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && next === "\n") index += 1;
      row.push(value.trim()); if (row.some(Boolean)) output.push(row); row = []; value = "";
    } else value += character;
  }
  row.push(value.trim()); if (row.some(Boolean)) output.push(row);
  return output;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function escapeHtml(value: unknown) {
  return String(value ?? "—").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character] || character);
}

function comparableAddress(value: string) {
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

function saveFile(name: string, contents: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: "text/html;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function saveAsPdf(report: string) {
  const printWindow = window.open("", "_blank");
  if (!printWindow) return;
  printWindow.document.open();
  printWindow.document.write(report);
  printWindow.document.close();
  window.setTimeout(() => {
    printWindow.focus();
    printWindow.print();
  }, 500);
}

function findValue(value: unknown, names: string[]): unknown {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const queue: unknown[] = [value];
  while (queue.length) {
    const item = queue.shift();
    if (!item || typeof item !== "object") continue;
    for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
      if (wanted.has(key.toLowerCase()) && child !== null && child !== undefined) return child;
      if (child && typeof child === "object") queue.push(child);
    }
  }
  return null;
}

function formatMoney(value: unknown) {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(number) : "Not available";
}

async function embedImage(source: string) {
  try {
    const response = await fetch("/api/corelogic/image?src=" + encodeURIComponent(source));
    if (!response.ok) return "";
    const image = await response.blob();
    if (!image.type.startsWith("image/")) return "";
    return await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
      reader.onerror = () => resolve("");
      reader.readAsDataURL(image);
    });
  } catch {
    return "";
  }
}

async function embeddedImages(sources: Array<string | null | undefined>) {
  const uniqueSources = [...new Set(sources.filter((source): source is string => Boolean(source)))].slice(0, 13);
  const results = await Promise.all(uniqueSources.map(async (source) => [source, await embedImage(source)] as const));
  return new Map(results);
}

async function makeReport(address: string, profile: unknown, comparables: unknown) {
  const property = record(profile), modules = record(property.modules);
  const core = record(record(modules.core).data), additional = record(record(modules.additional).data), location = record(record(modules.location).data);
  const lastSale = record(record(modules.lastSale).data), imageData = record(record(modules.images).data);
  const locality = record(location.locality), reference = record(record(comparables).reference);
  const image = record(imageData.defaultImage);
  const imageUrl = typeof image.largePhotoUrl === "string" ? image.largePhotoUrl : typeof image.mediumPhotoUrl === "string" ? image.mediumPhotoUrl : "";
  const avm = formatMoney(findValue(record(modules.avm).data, ["estimate", "avmEstimate", "consumerAvmEstimate", "estimatedValue", "value", "amount"]));
  const rentalAvm = formatMoney(findValue(record(modules.rentalAvm).data, ["rentalAvmEstimate", "estimate", "estimatedRent", "rent", "amount"]));
  const salePrice = formatMoney(findValue(lastSale, ["price", "salePrice", "saleAmount", "amount"]));
  const saleDate = findValue(lastSale, ["date", "saleDate", "contractDate", "settlementDate"]);
  const candidates = Array.isArray(record(comparables).candidates) ? record(comparables).candidates as Record<string, unknown>[] : [];
  const qualifiedCandidates = candidates.filter((candidate) => Number(record(candidate.score).total) >= 60 && Number.isFinite(Number(candidate.weeklyRent)) && Number(candidate.weeklyRent) > 0).slice(0, 12);
  const averageWeeklyRent = qualifiedCandidates.length ? qualifiedCandidates.reduce((sum, candidate) => sum + Number(candidate.weeklyRent), 0) / qualifiedCandidates.length : null;
  const embeddedImageSources = await embeddedImages([imageUrl, ...qualifiedCandidates.map((candidate) => typeof candidate.imageUrl === "string" ? candidate.imageUrl : null)]);
  const heroImage = imageUrl ? embeddedImageSources.get(String(imageUrl)) || "" : "";
  const candidateRows = qualifiedCandidates.map((candidate, index) => {
    const score = record(candidate.score), breakdown = record(score.breakdown);
    const locationText = candidate.distanceKm === null ? "Distance unavailable · same locality #" + String(candidate.localityId || "—") : String(candidate.distanceKm) + " km from reference";
    const breakdownText = "Type " + (breakdown.type || 0) + " · Beds " + (breakdown.bedrooms || 0) + " · Baths " + (breakdown.bathrooms || 0) + " · Cars " + (breakdown.cars || 0) + " · Area " + (breakdown.area || 0) + " · Location " + (breakdown.location || 0);
    const area = candidate.floorArea ? String(candidate.floorArea) + " m² floor" : candidate.landArea ? String(candidate.landArea) + " m² land" : "Area unavailable";
    const candidateImageSource = typeof candidate.imageUrl === "string" ? embeddedImageSources.get(candidate.imageUrl) || "" : "";
    const candidateImage = candidateImageSource ? "<img src='" + escapeHtml(candidateImageSource) + "' alt='" + escapeHtml(candidate.address) + "'>" : "<div class='image-fallback'>Image unavailable</div>";
    return "<article class='comp-card'><div class='comp-rank'><span>Match</span><strong>" + escapeHtml(score.total) + "</strong><small>/ 100</small></div><div class='comp-image'>" + candidateImage + "</div><div class='comp-copy'><span class='micro'>Comparable " + String(index + 1).padStart(2, "0") + " · Property ID " + escapeHtml(candidate.propertyId) + "</span><h3>" + escapeHtml(candidate.address) + "</h3><p>" + escapeHtml(candidate.propertyType) + " · " + escapeHtml(candidate.beds) + " bed · " + escapeHtml(candidate.baths) + " bath · " + escapeHtml(candidate.carSpaces) + " car · " + area + "</p><div class='score-line'>" + escapeHtml(breakdownText) + "</div></div><div class='comp-distance'><span>Distance from reference</span><strong>" + escapeHtml(locationText) + "</strong><small>Weekly rent: " + escapeHtml(formatMoney(candidate.weeklyRent)) + " / week</small></div></article>";
  }).join("");
  const fact = (label: string, value: unknown) => "<div><span>" + label + "</span><strong>" + escapeHtml(value) + "</strong></div>";
  const moduleCount = Object.keys(modules).length;
  const distanceNote = reference.coordinateAvailable === true
    ? "Distance is calculated from reference and candidate latitude/longitude with the Haversine formula."
    : "The reference property has no usable coordinate from Cotality, so distance is not invented. Each candidate receives the exact-locality fallback score instead.";
  return [
    "<!doctype html><html lang='en'><head><meta charset='utf-8'><title>", escapeHtml(address), " — Parcel Atlas report</title>",
    "<style>@page{size:A4;margin:10mm}body{background:#f4f1e8;color:#172022;font-family:Arial,sans-serif;margin:0}.wrap{margin:auto;max-width:1080px;padding:48px}header{background:#172022;color:white;padding:42px}.hero-image{display:block;max-height:480px;object-fit:cover;width:100%}h1{font-family:Georgia,serif;font-size:44px;font-weight:400;letter-spacing:-.04em;margin:12px 0}.tag{color:#d7ff45;font-size:11px;letter-spacing:.15em;text-transform:uppercase}.facts{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;margin:30px 0}.facts div{background:white;padding:20px}.facts span{color:#667070;font-size:10px;text-transform:uppercase}.facts strong{display:block;font-family:Georgia,serif;font-size:23px;font-weight:400;line-height:1.1;margin-top:8px}h2{font-family:Georgia,serif;font-size:34px;font-weight:400;margin:46px 0 11px}.note{background:#e8f8d0;border-left:4px solid #7c9c26;line-height:1.5;margin-top:25px;padding:17px}.source{color:#667070;font-size:11px;line-height:1.5}.rent-summary{background:#172022;color:white;display:flex;justify-content:space-between;margin-top:23px;padding:21px 24px}.rent-summary span,.rent-summary small{color:rgba(255,255,255,.55);font-size:9px;letter-spacing:.1em;text-transform:uppercase}.rent-summary strong{color:#d7ff45;font-family:Georgia,serif;font-size:34px;font-weight:400}.rent-summary div:last-child{text-align:right}.comp-grid{display:grid;gap:1px;margin-top:24px}.comp-card{background:white;display:grid;grid-template-columns:92px 190px minmax(240px,1fr) 210px;min-height:168px}.comp-rank{background:#172022;color:white;display:flex;flex-direction:column;justify-content:center;padding:18px}.comp-rank span,.comp-distance span,.micro{font-size:9px;letter-spacing:.1em;text-transform:uppercase}.comp-rank span{color:#8ce4dd}.comp-rank strong{color:#d7ff45;font-family:Georgia,serif;font-size:39px;font-weight:400;line-height:1;margin-top:11px}.comp-rank small{color:rgba(255,255,255,.5);font-size:10px;margin-top:2px}.comp-image{background:#293335;min-height:168px}.comp-image img{height:100%;object-fit:cover;width:100%}.image-fallback{align-items:center;color:#8ce4dd;display:flex;font-size:11px;height:100%;justify-content:center}.comp-copy{padding:23px 25px}.micro{color:#ff6940}.comp-copy h3{font-family:Georgia,serif;font-size:21px;font-weight:400;line-height:1.1;margin:10px 0 7px}.comp-copy p{color:#667070;font-size:11px;line-height:1.45;margin:0}.score-line{border-top:1px solid #ddd9cf;color:#667070;font-size:9px;line-height:1.45;margin-top:15px;padding-top:9px}.comp-distance{background:#e5f7d0;display:flex;flex-direction:column;justify-content:center;padding:20px}.comp-distance span{color:#657f1d}.comp-distance strong{font-family:Georgia,serif;font-size:20px;font-weight:400;line-height:1.15;margin-top:10px}.comp-distance small{color:#526043;font-size:10px;line-height:1.4;margin-top:8px}@media(max-width:720px){.wrap{padding:20px}.facts{grid-template-columns:repeat(2,1fr)}.rent-summary{display:block}.rent-summary div:last-child{margin-top:12px;text-align:left}.comp-card{grid-template-columns:70px 115px 1fr}.comp-distance{grid-column:2/-1}.comp-image{min-height:130px}}@media print{body{background:white}.wrap{max-width:none;padding:0}header{padding:20px 24px}.facts{margin:18px 0}.comp-card{break-inside:avoid}.comp-grid{gap:8px}.note{break-inside:avoid}}</style></head><body>",
    "<header class='wrap'><div class='tag'>Parcel Atlas / Property report</div><h1>", escapeHtml(location.singleLine || address), "</h1><p>Generated ", new Date().toLocaleString("en-AU"), " · CoreLogic/Cotality evidence</p></header>",
    heroImage ? "<img class='hero-image' src='" + escapeHtml(heroImage) + "' alt='Property image'>" : "",
    "<main class='wrap'><div class='facts'>", fact("Type", core.propertyType), fact("Bedrooms", core.beds), fact("Bathrooms", core.baths), fact("Car spaces", core.carSpaces), fact("Land area", String(core.landArea || "—") + " m²"), fact("Floor area", String(additional.floorArea || "—") + " m²"), fact("Locality", locality.singleLine), fact("Locality ID", locality.id), fact("Council", location.councilArea), fact("Property ID", property.propertyId), fact("Consumer AVM", avm), fact("Rental AVM", rentalAvm), fact("Last sale", salePrice), fact("Sale date", saleDate), fact("Data modules", moduleCount), "</div>",
    "<h2>Similar homes</h2><p>The candidate pool is sourced from the exact CoreLogic locality, then enriched and ranked using the configured 100-point property-similarity score. Only matches scoring 60/100 or above with confirmed weekly rental data are included in this report.</p>", averageWeeklyRent === null ? "" : "<div class='rent-summary'><div><span>Average weekly rent</span><strong>" + escapeHtml(formatMoney(averageWeeklyRent)) + " / week</strong></div><div><small>Calculated from " + qualifiedCandidates.length + " qualifying comparable" + (qualifiedCandidates.length === 1 ? "" : "s") + "</small></div></div>", "<div class='comp-grid'>", candidateRows || "<p>No comparable properties met both the 60/100 score threshold and weekly-rent requirement.</p>", "</div><div class='note'><strong>Distance handling:</strong> ", distanceNote, "<br><br><strong>Comparable inclusion rule:</strong> score ≥ 60 / 100 and a confirmed weekly rent · <strong>Score weights:</strong> type 35 · bedrooms 20 · bathrooms 15 · car spaces 10 · floor/land area 10 · locality or distance 10.</div><p class='source'>Source coverage: ", moduleCount, " connected Cotality response modules were included when this report was generated. Estimates, advertisements and registered sales are different evidence types and should not be treated as interchangeable.</p></main></body></html>"
  ].join("");
}

async function api<T>(url: string) {
  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.detail || "Request failed.");
  return payload as T;
}

export function BatchReports() {
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [loadingFile, setLoadingFile] = useState(false);
  const counts = useMemo(() => rows.reduce<Record<string, number>>((all, row) => { all[row.status] = (all[row.status] || 0) + 1; return all; }, {}), [rows]);
  const ready = rows.filter((row) => row.status === "ready").length;
  const complete = rows.filter((row) => row.status === "complete").length;

  function update(id: string, patch: Partial<BatchRow>) {
    setRows((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
  }

  async function match(address: string, rowNumber: number): Promise<BatchRow> {
    const base: BatchRow = { id: String(rowNumber) + "-" + address, rowNumber, originalAddress: address, suggestions: [], status: "matching", note: "Matching address…" };
    try {
      const [matcher, suggest] = await Promise.allSettled([
        api<{ matchDetails: MatchDetails | null }>("/api/corelogic/match?q=" + encodeURIComponent(address)),
        api<{ suggestions: Suggestion[] }>("/api/corelogic/search?q=" + encodeURIComponent(address)),
      ]);
      const matchDetails = matcher.status === "fulfilled" ? matcher.value.matchDetails : null;
      const suggestions = suggest.status === "fulfilled" ? suggest.value.suggestions.slice(0, 5) : [];
      const exactSuggestion = suggestions.find((item) => comparableAddress(item.suggestion) === comparableAddress(address));
      if (exactSuggestion) {
        return { ...base, propertyId: Number(exactSuggestion.propertyId), normalizedAddress: exactSuggestion.suggestion, suggestions, match: matchDetails, status: "ready", note: "Exact suggestion match — ready to process." };
      }
      if (suggestions.length) return { ...base, suggestions, match: matchDetails, status: "review", note: "No exact suggestion match. Choose the correct property." };
      return { ...base, match: matchDetails, status: "unmatched", note: "No Cotality property candidate found." };
    } catch (error) {
      return { ...base, status: "unmatched", note: error instanceof Error ? error.message : "Address matching failed." };
    }
  }

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return;
    setFileName(file.name); setLoadingFile(true); setRows([]);
    try {
      const source = parseCsv(await file.text()), headers = source[0] || [];
      const column = headers.findIndex((header) => /^(address|property address|full address)$/i.test(header.trim()));
      if (column < 0) { setRows([{ id: "format", rowNumber: 0, originalAddress: "", suggestions: [], status: "unmatched", note: "CSV requires address, property address, or full address column." }]); return; }
      const input = source.slice(1).map((row, index) => ({ address: row[column]?.trim() || "", rowNumber: index + 2 })).filter((row) => row.address);
      const results: BatchRow[] = [];
      for (const item of input) {
        results.push(await match(item.address, item.rowNumber));
        setRows([...results, ...input.slice(results.length).map((next) => ({ id: String(next.rowNumber) + "-" + next.address, rowNumber: next.rowNumber, originalAddress: next.address, suggestions: [], status: "matching" as Status, note: "Queued for address matching…" }))]);
      }
    } finally { setLoadingFile(false); event.target.value = ""; }
  }

  function approve(row: BatchRow, suggestion?: Suggestion) {
    update(row.id, { propertyId: suggestion ? Number(suggestion.propertyId) : row.propertyId, normalizedAddress: suggestion?.suggestion || row.normalizedAddress || row.originalAddress, status: "ready", note: "Reviewer approved this property." });
  }

  async function process(row: BatchRow) {
    if (!row.propertyId) return;
    update(row.id, { status: "processing", note: "Loading property and comparable evidence…" });
    try {
      const [profile, comparables] = await Promise.all([api<unknown>("/api/corelogic/properties/" + row.propertyId), api<unknown>("/api/corelogic/properties/" + row.propertyId + "/comparables")]);
      const report = await makeReport(row.normalizedAddress || row.originalAddress, profile, comparables);
      update(row.id, { status: "complete", note: "HTML report with embedded images ready.", report });
    } catch (error) {
      update(row.id, { status: "failed", note: "Report could not be generated.", error: error instanceof Error ? error.message : "Processing failed." });
    }
  }

  async function processBatch() {
    const queue = rows.filter((row) => row.status === "ready");
    let cursor = 0;
    async function worker() { while (cursor < queue.length) { const next = queue[cursor++]; await process(next); } }
    // Keep batch work deliberately serial so multiple property dossiers do
    // not burst against the Cotality sandbox rate limit.
    await worker();
  }

  return <section className="batch-reports" id="batch-reports">
    <header className="batch-heading"><div><p className="micro-label">Batch reports / CSV to evidence</p><h2>From property list to review-ready reports.</h2></div><p>Addresses are matched first. Only a validated or reviewer-approved property enters the Cotality report workflow.</p></header>
    <div className="batch-upload"><div><FileText size={26} /><h3>Upload property CSV</h3><p>Required column: <code>address</code>, <code>property address</code>, or <code>full address</code>.</p><label className="batch-file-picker"><input type="file" accept=".csv,text/csv" onChange={upload} disabled={loadingFile} />{loadingFile ? <><LoaderCircle className="spin" size={16} /> Reading & matching</> : <>Choose CSV <ArrowRight size={16} /></>}</label><small>{fileName || "No file selected"} · <a href="/sample-property-batch.csv" download>Download sample CSV</a></small></div><aside><span>Safeguard</span><strong>Review before report</strong><p>Ambiguous units or multiple suggestions remain in the review queue. No report is generated until a candidate is selected.</p></aside></div>
    {rows.length ? <><div className="batch-stats"><div><span>Rows</span><strong>{rows.length}</strong></div><div><span>Ready</span><strong>{counts.ready || 0}</strong></div><div><span>Review</span><strong>{counts.review || 0}</strong></div><div><span>Completed</span><strong>{complete}</strong></div><button onClick={() => void processBatch()} disabled={!ready || loadingFile}>{ready ? "Generate " + ready + " report" + (ready === 1 ? "" : "s") : "No approved reports"} <ArrowRight size={16} /></button></div>
      <div className="batch-ledger"><div className="batch-ledger-heading"><span>CSV row</span><span>Original input</span><span>Match decision</span><span>Report status</span></div>{rows.map((row) => <article key={row.id}><span className="batch-row-number">{row.rowNumber || "!"}</span><div className="batch-address"><strong>{row.originalAddress || "CSV format error"}</strong>{row.normalizedAddress && row.normalizedAddress !== row.originalAddress ? <small>Normalized: {row.normalizedAddress}</small> : null}</div><div className="batch-match"><span className={"batch-status " + row.status}>{row.status === "complete" || row.status === "ready" ? <Check size={13} /> : row.status === "matching" || row.status === "processing" ? <LoaderCircle className="spin" size={13} /> : <CircleDashed size={13} />}{row.status}</span><p>{row.note}</p>{row.status === "review" ? <div className="batch-suggestions">{row.suggestions.map((suggestion, index) => <button key={String(suggestion.propertyId) + "-" + index} onClick={() => approve(row, suggestion)}><Search size={13} />{suggestion.suggestion}</button>)}</div> : null}</div><div className="batch-output">{row.status === "complete" && row.report ? <><button onClick={() => saveFile("parcel-atlas-" + row.propertyId + ".html", row.report || "")}><FileText size={14} />Download HTML</button><button className="pdf-button" onClick={() => saveAsPdf(row.report || "")}><Printer size={14} />Save as PDF</button></> : row.status === "failed" ? <span className="batch-error">{row.error}</span> : <span>—</span>}</div></article>)}</div>
      {complete ? <div className="batch-export"><span>{complete} HTML report{complete === 1 ? "" : "s"} ready in this browser session.</span><button onClick={() => saveFile("parcel-atlas-batch-index.html", "<!doctype html><title>Parcel Atlas batch</title><h1>Parcel Atlas batch reports</h1><p>Generated " + new Date().toLocaleString("en-AU") + "</p>")}>Download batch index <ArrowRight size={15} /></button></div> : null}
    </> : <div className="batch-empty"><Search size={21} /><span>Upload a CSV to start address validation and report preparation.</span></div>}
  </section>;
}
