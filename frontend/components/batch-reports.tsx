"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Check, CircleDashed, Database, FileText, LoaderCircle, Mail, Printer, RefreshCw, Search, Send, Zap } from "lucide-react";

type AutoPilotStage =
  | "idle"
  // Mailbox run: dispatch is asynchronous, so acceptance and execution differ.
  | "dispatching"
  | "dispatched"
  | "running"
  // Shared with the manual uploaded-CSV path.
  | "queued"
  | "matching"
  | "generating"
  | "sending"
  | "done"
  | "error";

type DurableJob = {
  id: string;
  sender: string;
  subject: string;
  status: string;
  attempts: number;
  error: string | null;
  filename: string;
  row_count: number;
  report_count: number;
  review_count: number;
  created_at: string;
};

type JobDetail = {
  job: { id: string; status: string; error: string | null; attempts: number };
  reports: Array<{ rowNumber: number; originalAddress: string; status: string; reportFilename: string | null; error: string | null }>;
  replies: Array<{ status: string; reportCount: number; sentAt: string | null }>;
};

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

type ReportCandidate = Record<string, unknown>;

function median(values: number[]) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function selectQualityComparableRents(candidates: ReportCandidate[]) {
  const scoreEligible = candidates.filter((candidate) => Number(record(candidate.score).total) >= 60);
  const hardValid = scoreEligible.filter((candidate) => {
    const rent = Number(candidate.weeklyRent);
    return Number.isFinite(rent) && rent >= 100 && rent <= 25_000;
  });
  const excluded = scoreEligible.filter((candidate) => !hardValid.includes(candidate));
  let selected = hardValid;

  if (hardValid.length >= 3) {
    const marketMedian = median(hardValid.map((candidate) => Number(candidate.weeklyRent)));
    const lowerBound = Math.max(100, marketMedian * 0.35);
    const upperBound = Math.min(25_000, marketMedian * 3);
    selected = hardValid.filter((candidate) => {
      const rent = Number(candidate.weeklyRent);
      return rent >= lowerBound && rent <= upperBound;
    });
    excluded.push(...hardValid.filter((candidate) => !selected.includes(candidate)));
  }

  return { selected: selected.slice(0, 12), excluded };
}

async function embedImage(source: string) {
  try {
    // Images are supplementary evidence. A slow upstream image must never
    // prevent the property report itself from finishing.
    const response = await fetch("/api/corelogic/image?src=" + encodeURIComponent(source), { signal: AbortSignal.timeout(8_000) });
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
  const candidates = Array.isArray(record(comparables).candidates) ? record(comparables).candidates as ReportCandidate[] : [];
  const rentQuality = selectQualityComparableRents(candidates);
  const qualifiedCandidates = rentQuality.selected;
  const averageWeeklyRent = qualifiedCandidates.length ? qualifiedCandidates.reduce((sum, candidate) => sum + Number(candidate.weeklyRent), 0) / qualifiedCandidates.length : null;
  const excludedRentNote = rentQuality.excluded.length
    ? `<p class='quality-note'>Rent-quality check excluded ${rentQuality.excluded.length} comparable${rentQuality.excluded.length === 1 ? "" : "s"} with a missing, implausible, or market-outlier weekly rent before the average was calculated.</p>`
    : "";
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
    "<style>@page{size:A4;margin:10mm}body{background:#f4f1e8;color:#172022;font-family:Arial,sans-serif;margin:0}.wrap{margin:auto;max-width:1080px;padding:48px}header{background:#172022;color:white;padding:42px}.hero-image{display:block;max-height:480px;object-fit:cover;width:100%}h1{font-family:Georgia,serif;font-size:44px;font-weight:400;letter-spacing:-.04em;margin:12px 0}.tag{color:#d7ff45;font-size:11px;letter-spacing:.15em;text-transform:uppercase}.facts{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;margin:30px 0}.facts div{background:white;padding:20px}.facts span{color:#667070;font-size:10px;text-transform:uppercase}.facts strong{display:block;font-family:Georgia,serif;font-size:23px;font-weight:400;line-height:1.1;margin-top:8px}h2{font-family:Georgia,serif;font-size:34px;font-weight:400;margin:46px 0 11px}.note{background:#e8f8d0;border-left:4px solid #7c9c26;line-height:1.5;margin-top:25px;padding:17px}.source{color:#667070;font-size:11px;line-height:1.5}.quality-note{background:#fff0c7;border-left:4px solid #d69c1d;color:#5f4a18;font-size:11px;line-height:1.5;margin:14px 0 0;padding:12px 14px}.rent-summary{background:#172022;color:white;display:flex;justify-content:space-between;margin-top:23px;padding:21px 24px}.rent-summary span,.rent-summary small{color:rgba(255,255,255,.55);font-size:9px;letter-spacing:.1em;text-transform:uppercase}.rent-summary strong{color:#d7ff45;font-family:Georgia,serif;font-size:34px;font-weight:400}.rent-summary div:last-child{text-align:right}.comp-grid{display:grid;gap:1px;margin-top:24px}.comp-card{background:white;display:grid;grid-template-columns:92px 190px minmax(240px,1fr) 210px;min-height:168px}.comp-rank{background:#172022;color:white;display:flex;flex-direction:column;justify-content:center;padding:18px}.comp-rank span,.comp-distance span,.micro{font-size:9px;letter-spacing:.1em;text-transform:uppercase}.comp-rank span{color:#8ce4dd}.comp-rank strong{color:#d7ff45;font-family:Georgia,serif;font-size:39px;font-weight:400;line-height:1;margin-top:11px}.comp-rank small{color:rgba(255,255,255,.5);font-size:10px;margin-top:2px}.comp-image{background:#293335;min-height:168px}.comp-image img{height:100%;object-fit:cover;width:100%}.image-fallback{align-items:center;color:#8ce4dd;display:flex;font-size:11px;height:100%;justify-content:center}.comp-copy{padding:23px 25px}.micro{color:#ff6940}.comp-copy h3{font-family:Georgia,serif;font-size:21px;font-weight:400;line-height:1.1;margin:10px 0 7px}.comp-copy p{color:#667070;font-size:11px;line-height:1.45;margin:0}.score-line{border-top:1px solid #ddd9cf;color:#667070;font-size:9px;line-height:1.45;margin-top:15px;padding-top:9px}.comp-distance{background:#e5f7d0;display:flex;flex-direction:column;justify-content:center;padding:20px}.comp-distance span{color:#657f1d}.comp-distance strong{font-family:Georgia,serif;font-size:20px;font-weight:400;line-height:1.15;margin-top:10px}.comp-distance small{color:#526043;font-size:10px;line-height:1.4;margin-top:8px}@media(max-width:720px){.wrap{padding:20px}.facts{grid-template-columns:repeat(2,1fr)}.rent-summary{display:block}.rent-summary div:last-child{text-align:left;margin-top:12px}.comp-card{grid-template-columns:70px 115px 1fr}.comp-distance{grid-column:2/-1}.comp-image{min-height:130px}}@media print{body{background:white}.wrap{max-width:none;padding:0}header{padding:20px 24px}.facts{margin:18px 0}.comp-card{break-inside:avoid}.comp-grid{gap:8px}.note{break-inside:avoid}}</style></head><body>",
    "<header class='wrap'><div class='tag'>Parcel Atlas / Property report</div><h1>", escapeHtml(location.singleLine || address), "</h1><p>Generated ", new Date().toLocaleString("en-AU"), " · CoreLogic/Cotality evidence</p></header>",
    heroImage ? "<img class='hero-image' src='" + escapeHtml(heroImage) + "' alt='Property image'>" : "",
    "<main class='wrap'><div class='facts'>", fact("Type", core.propertyType), fact("Bedrooms", core.beds), fact("Bathrooms", core.baths), fact("Car spaces", core.carSpaces), fact("Land area", String(core.landArea || "—") + " m²"), fact("Floor area", String(additional.floorArea || "—") + " m²"), fact("Locality", locality.singleLine), fact("Locality ID", locality.id), fact("Council", location.councilArea), fact("Property ID", property.propertyId), fact("Consumer AVM", avm), fact("Rental AVM", rentalAvm), fact("Last sale", salePrice), fact("Sale date", saleDate), fact("Data modules", moduleCount), "</div>",
    "<h2>Similar homes</h2><p>The candidate pool is sourced from the exact CoreLogic locality, then enriched and ranked using the configured 100-point property-similarity score. Only matches scoring 60/100 or above with confirmed weekly rental data are included in this report.</p>", averageWeeklyRent === null ? "" : "<div class='rent-summary'><div><span>Average weekly rent</span><strong>" + escapeHtml(formatMoney(averageWeeklyRent)) + " / week</strong></div><div><small>Calculated from " + qualifiedCandidates.length + " qualifying comparable" + (qualifiedCandidates.length === 1 ? "" : "s") + "</small></div></div>", excludedRentNote, "<div class='comp-grid'>", candidateRows || "<p>No comparable properties met the score and rent-quality requirements.</p>", "</div><div class='note'><strong>Distance handling:</strong> ", distanceNote, "<br><br><strong>Comparable inclusion rule:</strong> score ≥ 60 / 100, confirmed weekly rent, and rent-quality validation · <strong>Score weights:</strong> type 35 · bedrooms 20 · bathrooms 15 · car spaces 10 · floor/land area 10 · locality or distance 10.</div><p class='source'>Source coverage: ", moduleCount, " connected Cotality response modules were included when this report was generated. Estimates, advertisements and registered sales are different evidence types and should not be treated as interchangeable.</p></main></body></html>"
  ].join("");
}

async function api<T>(url: string, timeoutMs = 30_000) {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(`This Cotality request did not respond within ${Math.ceil(timeoutMs / 1_000)} seconds.`);
    }
    throw error;
  }
  const body = await response.text();
  let payload: { detail?: string } | T | null = null;
  try { payload = body ? JSON.parse(body) as T : null; }
  catch {
    throw new Error(`Request failed (${response.status}): ${body.slice(0, 160) || "The server did not return JSON."}`);
  }
  if (!response.ok) {
    const detail = payload && typeof payload === "object" && "detail" in payload ? payload.detail : null;
    throw new Error(typeof detail === "string" ? detail : `Request failed (${response.status}).`);
  }
  return payload as T;
}

export function BatchReports() {
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [loadingFile, setLoadingFile] = useState(false);
  const [gmail, setGmail] = useState<{ configured: boolean; connected: boolean; email: string | null; allowedSendersConfigured: boolean } | null>(null);
  const [gmailBusy, setGmailBusy] = useState(false);
  const [gmailNotice, setGmailNotice] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [sourceMessageId, setSourceMessageId] = useState("");
  const [autoPilotStage, setAutoPilotStage] = useState<AutoPilotStage>("idle");
  const [autoPilotDetail, setAutoPilotDetail] = useState("");
  const [pendingCsv, setPendingCsv] = useState<{ name: string; text: string } | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const [dispatchConfigured, setDispatchConfigured] = useState<boolean | null>(null);
  const [jobDetail, setJobDetail] = useState<JobDetail | null>(null);
  const counts = useMemo(() => rows.reduce<Record<string, number>>((all, row) => { all[row.status] = (all[row.status] || 0) + 1; return all; }, {}), [rows]);
  const ready = rows.filter((row) => row.status === "ready").length;
  const complete = rows.filter((row) => row.status === "complete").length;

  const [dbJobs, setDbJobs] = useState<DurableJob[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [workerHealthy, setWorkerHealthy] = useState<boolean | null>(null);

  // Demo-mode job state comes directly from Neon through the read-only API.
  const fetchJobs = useCallback(async () => {
    try {
      setLoadingJobs(true);
      const response = await fetch("/api/gmail/jobs", { cache: "no-store" });
      const data = await response.json() as { ok?: boolean; jobs?: DurableJob[] };
      if (response.ok && data.ok && Array.isArray(data.jobs)) setDbJobs(data.jobs);
    } catch {
      // transient network failure; the next poll retries
    } finally {
      setLoadingJobs(false);
    }
  }, []);

  const fetchWorkerHealth = useCallback(async () => {
    try {
      const response = await fetch("/api/worker/health", { cache: "no-store" });
      if (!response.ok) { setWorkerHealthy(null); return; }
      const data = await response.json() as { healthy?: boolean };
      setWorkerHealthy(Boolean(data.healthy));
    } catch {
      setWorkerHealthy(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Defer the first fetch so the effect body itself does not call setState,
    // which would trigger cascading renders.
    const bootstrap = setTimeout(() => {
      if (cancelled) return;
      void fetch("/api/gmail/status").then((response) => response.json()).then(setGmail).catch(() => setGmail(null));
      void fetchJobs();
      void fetchWorkerHealth();
      // Disable the mailbox CTA up front if this deployment cannot dispatch.
      void fetch("/api/pipeline/trigger", { cache: "no-store" })
        .then((response) => response.json())
        .then((data: { configured?: boolean }) => { if (!cancelled) setDispatchConfigured(Boolean(data.configured)); })
        .catch(() => { if (!cancelled) setDispatchConfigured(null); });
    }, 0);
    const interval = setInterval(() => { void fetchJobs(); void fetchWorkerHealth(); }, 10_000);
    return () => { cancelled = true; clearTimeout(bootstrap); clearInterval(interval); };
  }, [fetchJobs, fetchWorkerHealth]);

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
      const exactMatcherId = Number(matchDetails?.propertyId);
      const isExactMatcher = matchDetails?.matchType === "E" && Number.isSafeInteger(exactMatcherId) && exactMatcherId > 0;
      if (isExactMatcher) {
        const matchingSuggestion = suggestions.find((item) => Number(item.propertyId) === exactMatcherId);
        return { ...base, propertyId: exactMatcherId, normalizedAddress: matchingSuggestion?.suggestion || address, suggestions, match: matchDetails, status: "ready", note: "Exact Address Matcher result — ready to process." };
      }
      if (exactSuggestion) {
        return { ...base, propertyId: Number(exactSuggestion.propertyId), normalizedAddress: exactSuggestion.suggestion, suggestions, match: matchDetails, status: "ready", note: "Exact suggestion match — ready to process." };
      }
      if (suggestions.length) return { ...base, suggestions, match: matchDetails, status: "review", note: "No exact suggestion match. Choose the correct property." };
      return { ...base, match: matchDetails, status: "unmatched", note: "No Cotality property candidate found." };
    } catch (error) {
      return { ...base, status: "unmatched", note: error instanceof Error ? error.message : "Address matching failed." };
    }
  }

  async function queueCsv(sourceText: string, name: string, origin?: { sender: string; messageId: string }) {
    setFileName(name); setLoadingFile(true); setRows([]);
    if (origin) { setReplyTo(origin.sender); setSourceMessageId(origin.messageId); }
    try {
      const source = parseCsv(sourceText), headers = source[0] || [];
      const column = headers.findIndex((header) => /^(address|property address|full address)$/i.test(header.trim()));
      if (column < 0) { setRows([{ id: "format", rowNumber: 0, originalAddress: "", suggestions: [], status: "unmatched", note: "CSV requires address, property address, or full address column." }]); return; }
      const input = source.slice(1).map((row, index) => ({ address: row[column]?.trim() || "", rowNumber: index + 2 })).filter((row) => row.address);
      const results: BatchRow[] = [];
      for (const item of input) {
        results.push(await match(item.address, item.rowNumber));
        setRows([...results, ...input.slice(results.length).map((next) => ({ id: String(next.rowNumber) + "-" + next.address, rowNumber: next.rowNumber, originalAddress: next.address, suggestions: [], status: "matching" as Status, note: "Queued for address matching…" }))]);
      }
    } finally { setLoadingFile(false); }
  }

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return;
    setReplyTo(""); setSourceMessageId("");
    const text = await file.text();
    // Retained so Auto-pilot can hand the exact bytes to the durable job API.
    setPendingCsv({ name: file.name, text });
    await queueCsv(text, file.name);
    event.target.value = "";
  }

  async function syncGmail() {
    setGmailBusy(true); setGmailNotice("");
    try {
      const response = await fetch("/api/gmail/sync", { method: "POST" });
      const payload = await response.json() as { detail?: string; imports?: Array<{ sender: string; messageId: string; fileName: string; csv: string }> };
      if (!response.ok) throw new Error(payload.detail || "Inbox check failed.");
      const incoming = payload.imports?.[0];
      if (!incoming) { setGmailNotice("No unread CSV from an approved sender was found."); return; }
      await queueCsv(incoming.csv, incoming.fileName, incoming);
      setGmailNotice(`Imported ${incoming.fileName} from ${incoming.sender}. Review and generate the reports below.`);
    } catch (error) { setGmailNotice(error instanceof Error ? error.message : "Inbox check failed."); }
    finally { setGmailBusy(false); }
  }

  async function replyWithReports() {
    const reports = rows.filter((row) => row.status === "complete" && row.report).map((row) => ({ fileName: `parcel-atlas-${row.propertyId}.html`, html: row.report || "" }));
    if (!replyTo || !reports.length) return;
    setGmailBusy(true); setGmailNotice("");
    try {
      const response = await fetch("/api/gmail/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ recipient: replyTo, subject: `Parcel Atlas rent-review reports (${reports.length})`, reports, sourceMessageId }) });
      const payload = await response.json() as { detail?: string };
      if (!response.ok) throw new Error(payload.detail || "Report reply failed.");
      setGmailNotice(`Sent ${reports.length} HTML report${reports.length === 1 ? "" : "s"} to ${replyTo}.`);
    } catch (error) { setGmailNotice(error instanceof Error ? error.message : "Report reply failed."); }
    finally { setGmailBusy(false); }
  }

  function approve(row: BatchRow, suggestion?: Suggestion) {
    update(row.id, { propertyId: suggestion ? Number(suggestion.propertyId) : row.propertyId, normalizedAddress: suggestion?.suggestion || row.normalizedAddress || row.originalAddress, status: "ready", note: "Reviewer approved this property." });
  }

  async function process(row: BatchRow) {
    if (!row.propertyId) return;
    update(row.id, { status: "processing", note: "Loading property and comparable evidence…" });
    try {
      // Cotality's sandbox is rate-limited. Keep each dossier request ordered
      // as well as the batch itself so a CSV cannot create a small request burst.
      const profile = await api<unknown>("/api/corelogic/properties/" + row.propertyId, 120_000);
      const comparables = await api<unknown>("/api/corelogic/properties/" + row.propertyId + "/comparables", 120_000);
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

  const autoPilotStageLabel: Record<AutoPilotStage, string> = {
    idle: "",
    dispatching: "Starting mailbox run…",
    dispatched: "Run accepted",
    running: "Processing mailbox…",
    queued: "Queued…",
    matching: "Matching addresses…",
    generating: "Generating reports…",
    sending: "Emailing reports…",
    done: "Pipeline complete.",
    error: "The pipeline reported an error.",
  };

  /**
   * Starts a real mailbox run by dispatching the GitHub Actions worker.
   *
   * Needs no uploaded CSV and no reply address: the worker reads the mailbox
   * itself. Dispatch is asynchronous, so this reports acceptance and then lets
   * the durable job list show what the worker actually records.
   */
  async function runMailboxPipeline() {
    setDispatching(true);
    setAutoPilotStage("dispatching");
    setAutoPilotDetail("Starting mailbox run…");
    setGmailNotice("");
    try {
      const response = await fetch("/api/pipeline/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Manual UI Auto-pilot request" }),
      });
      const payload = await response.json() as { ok?: boolean; error?: string; detail?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.error || "The mailbox run could not be started.");

      setAutoPilotStage("dispatched");
      setAutoPilotDetail(
        payload.detail
          || "GitHub Actions accepted the run. Checking Gmail and processing CSV reports in the background.",
      );
      // Watch for the job rows the run creates rather than asserting success.
      await fetchJobs();
      void watchForNewJobs();
    } catch (error) {
      setAutoPilotStage("error");
      setAutoPilotDetail(error instanceof Error ? error.message : "The mailbox run could not be started.");
    } finally {
      setDispatching(false);
    }
  }

  /**
   * Follows the dispatched run by watching Neon for new jobs. A GitHub run
   * queues before it starts, so absence of a job is not yet a failure.
   */
  async function watchForNewJobs() {
    // Bounded by attempt count rather than wall-clock reads, which the React
    // compiler treats as impure inside a component.
    const intervalMs = 10_000;
    const maxAttempts = Math.ceil((12 * 60_000) / intervalMs);
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, intervalMs));
      const response = await fetch("/api/gmail/jobs", { cache: "no-store" });
      if (!response.ok) continue;
      const data = await response.json() as { ok?: boolean; jobs?: DurableJob[] };
      if (!data.ok || !Array.isArray(data.jobs)) continue;
      setDbJobs(data.jobs);

      const active = data.jobs.find((job) => !["completed", "failed"].includes(job.status));
      if (active) {
        setAutoPilotStage("running");
        setAutoPilotDetail(
          `Job ${active.id} is ${active.status.replace(/_/g, " ")} — ${active.report_count}/${active.row_count} report(s) generated.`,
        );
        await pollJob(active.id);
        return;
      }
    }
    setAutoPilotStage("dispatched");
    setAutoPilotDetail(
      "The run was accepted but has not created a job yet. It may have found no new CSV attachments, or GitHub may still be queuing it. Use Refresh to check again.",
    );
  }

  /**
   * Queues the CSV that was uploaded in this browser. Kept separate from the
   * mailbox run: this one legitimately needs a file and a reply address.
   */
  async function queueUploadedCsv() {
    if (!pendingCsv) {
      setAutoPilotStage("error");
      setAutoPilotDetail("Choose a CSV file first.");
      return;
    }
    if (!replyTo) {
      setAutoPilotStage("error");
      setAutoPilotDetail("Enter the reply email address for the uploaded CSV.");
      return;
    }

    setGmailBusy(true); setAutoPilotStage("queued"); setAutoPilotDetail("Uploading the CSV and queueing a durable job…"); setGmailNotice("");
    try {
      const response = await fetch("/api/gmail/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: pendingCsv.name,
          csvContent: pendingCsv.text,
          sender: replyTo,
          subject: `Parcel Atlas rent review — ${pendingCsv.name}`,
        }),
      });
      const payload = await response.json() as { ok?: boolean; error?: string; created?: boolean; job?: { id: string }; rowCount?: number };
      if (!response.ok || !payload.ok || !payload.job) throw new Error(payload.error || "The job could not be queued.");

      setAutoPilotDetail(payload.created
        ? `Job ${payload.job.id} queued with ${payload.rowCount} address row(s). Waiting for the worker…`
        : `This CSV was already queued as ${payload.job.id}; showing its existing progress.`);
      await fetchJobs();
      await pollJob(payload.job.id);
    } catch (error) {
      setAutoPilotStage("error");
      setAutoPilotDetail(error instanceof Error ? error.message : "The CSV could not be queued.");
    } finally {
      setGmailBusy(false);
    }
  }

  /** Polls durable job state in Neon until it reaches a terminal status. */
  async function pollJob(jobId: string) {
    const deadline = Date.now() + 30 * 60_000;
    while (Date.now() < deadline) {
      const response = await fetch(`/api/gmail/jobs/${jobId}`, { cache: "no-store" });
      if (!response.ok) { setAutoPilotStage("error"); setAutoPilotDetail("Job status could not be read."); return; }
      const detail = await response.json() as JobDetail;
      setJobDetail(detail);

      const generated = detail.reports.filter((report) => report.status === "generated").length;
      const review = detail.reports.filter((report) => report.status === "needs_review" || report.status === "unmatched").length;

      if (detail.job.status === "queued" || detail.job.status === "claimed") {
        setAutoPilotStage("queued");
        setAutoPilotDetail("Waiting for the background worker to claim this job…");
      } else if (["running", "downloaded", "matched"].includes(detail.job.status)) {
        setAutoPilotStage("matching");
        setAutoPilotDetail(`Matching addresses through Cotality — ${generated} report(s) so far.`);
      } else if (detail.job.status === "report_generated") {
        setAutoPilotStage("generating");
        setAutoPilotDetail(`${generated} report(s) generated and stored.`);
      } else if (detail.job.status === "replying") {
        setAutoPilotStage("sending");
        setAutoPilotDetail(`Emailing ${generated} report(s) to ${replyTo}…`);
      } else if (detail.job.status === "retryable_failed") {
        setAutoPilotStage("generating");
        setAutoPilotDetail(`Transient failure on attempt ${detail.job.attempts}; a retry is scheduled. ${detail.job.error ?? ""}`);
      } else if (detail.job.status === "completed") {
        setAutoPilotStage("done");
        setAutoPilotDetail(`Complete: ${generated} report(s) emailed to ${replyTo}.${review ? ` ${review} row(s) need manual review.` : ""}`);
        await fetchJobs();
        return;
      } else if (detail.job.status === "needs_review") {
        setAutoPilotStage("error");
        setAutoPilotDetail(`${review} address row(s) need manual property selection. No exact Cotality match was found.`);
        await fetchJobs();
        return;
      } else if (detail.job.status === "needs_reauthentication") {
        setAutoPilotStage("error");
        setAutoPilotDetail("Google requires manual re-authentication of the bot mailbox. The worker stopped safely without retrying credentials.");
        await fetchJobs();
        return;
      } else if (detail.job.status === "failed") {
        setAutoPilotStage("error");
        setAutoPilotDetail(detail.job.error || "The job failed.");
        await fetchJobs();
        return;
      }

      await new Promise((resolve) => window.setTimeout(resolve, 5_000));
    }
    setAutoPilotStage("error");
    setAutoPilotDetail("Stopped following this job after 30 minutes. It continues in the background; use Refresh to check.");
  }

  return <section className="batch-reports" id="batch-reports">
    <header className="batch-heading"><div><p className="micro-label">Batch reports / CSV to evidence</p><h2>From property list to review-ready reports.</h2></div><p>Addresses are matched first. Only a validated or reviewer-approved property enters the Cotality report workflow.</p></header>
    <div className="batch-upload"><div><FileText size={26} /><h3>Upload property CSV</h3><p>Required column: <code>address</code>, <code>property address</code>, or <code>full address</code>.</p><label className="batch-file-picker"><input type="file" accept=".csv,text/csv" onChange={upload} disabled={loadingFile} />{loadingFile ? <><LoaderCircle className="spin" size={16} /> Reading & matching</> : <>Choose CSV <ArrowRight size={16} /></>}</label><small>{fileName || "No file selected"} · <a href="/sample-property-batch.csv" download>Download sample CSV</a></small>
      {pendingCsv ? <div className="manual-queue">
        <label>
          <span>Reply email for this upload</span>
          <input type="email" value={replyTo} onChange={(event) => setReplyTo(event.target.value)} placeholder="name@example.com" autoComplete="email" />
        </label>
        <button className="gmail-action" onClick={() => void queueUploadedCsv()} disabled={gmailBusy || loadingFile || !replyTo}>
          {gmailBusy ? <LoaderCircle className="spin" size={14} /> : <Database size={14} />}Queue uploaded CSV
        </button>
        <small>Queues this file as a durable job. The background worker generates the reports and emails them to the address above.</small>
      </div> : null}
    </div><aside><span>Safeguard</span><strong>Review before report</strong><p>Ambiguous units or multiple suggestions remain in the review queue. No report is generated until a candidate is selected.</p></aside></div>
    <div className="gmail-dock">
      <div className="gmail-dock-mark"><Mail size={20} /><span>Inbound mailbox</span></div>
      <div className="gmail-dock-copy"><strong>Scan Gmail inbox and process CSV attachments</strong><small>Auto-pilot starts a background run that reads the report mailbox over a hosted browser, generates a Cotality report for every exact address match, and replies to each sender with their reports attached. No upload needed. Runs also happen automatically every 15 minutes.</small></div>
      <div className="gmail-dock-actions">
        {gmail?.connected ? <button className="gmail-action" onClick={() => void syncGmail()} disabled={gmailBusy || loadingFile || autoPilotStage !== "idle"}>{gmailBusy ? <LoaderCircle className="spin" size={14} /> : <Mail size={14} />}Check inbox</button> : <a href="/api/gmail/connect" className="gmail-action" aria-disabled={!gmail?.configured}>Connect OAuth <ArrowRight size={14} /></a>}
        <button
          className="gmail-action autopilot"
          onClick={() => void runMailboxPipeline()}
          disabled={dispatching || dispatchConfigured === false}
          title={dispatchConfigured === false ? "Mailbox runs are not configured on this deployment." : "Scan the Gmail inbox for CSV attachments"}
        >
          {dispatching ? <LoaderCircle className="spin" size={14} /> : <Zap size={14} />}
          Auto-pilot: scan inbox
        </button>
        {replyTo && complete ? <button className="gmail-action send-back" onClick={() => void replyWithReports()} disabled={gmailBusy}><Send size={14} />Send reports back</button> : null}
      </div>
      {gmailNotice ? <p className="gmail-notice">{gmailNotice}</p> : null}
    </div>
    {autoPilotStage !== "idle" ? <div className="autopilot-progress">
      <div className="autopilot-stages">
        {(["dispatching", "dispatched", "running", "sending"] as const).map((stage) => {
          const stages: AutoPilotStage[] = ["dispatching", "dispatched", "running", "sending"];
          // The manual upload path reuses the later stages, so map its states
          // onto the same indicator rather than showing nothing.
          const normalized: AutoPilotStage =
            autoPilotStage === "done" ? "sending"
            : autoPilotStage === "queued" ? "dispatched"
            : autoPilotStage === "matching" || autoPilotStage === "generating" ? "running"
            : autoPilotStage;
          const currentIndex = stages.indexOf(normalized);
          const stageIndex = stages.indexOf(stage);
          const isDone = autoPilotStage === "done" || (currentIndex >= 0 && stageIndex < currentIndex);
          const isActive = stage === normalized && autoPilotStage !== "error";
          const isError = autoPilotStage === "error" && stageIndex === Math.max(currentIndex, 0);
          return <div key={stage} className={`autopilot-step${isDone ? " done" : ""}${isActive ? " active" : ""}${isError ? " error" : ""}`}>
            {isDone ? <Check size={13} /> : isActive ? <LoaderCircle className="spin" size={13} /> : isError ? <CircleDashed size={13} /> : <CircleDashed size={13} />}
            <span>{autoPilotStageLabel[stage]?.replace("…", "") || stage}</span>
          </div>;
        })}
      </div>
      <p className="autopilot-detail">{autoPilotDetail}</p>
      {jobDetail?.reports.length ? <ul className="autopilot-rows">
        {jobDetail.reports.map((report) => <li key={report.rowNumber}>
          <span className={`batch-status ${report.status}`}>{report.status.replace("_", " ")}</span>
          <span>{report.originalAddress}</span>
          {report.error ? <small>{report.error}</small> : null}
        </li>)}
      </ul> : null}
    </div> : null}
    <div className="durable-jobs">
      <div className="durable-jobs-head">
        <div>
          <Database size={17} />
          <strong>Durable pipeline jobs</strong>
          <span className={`worker-pill ${workerHealthy === true ? "ok" : workerHealthy === false ? "down" : "unknown"}`}>
            {workerHealthy === true ? "Worker online" : workerHealthy === false ? "Worker offline" : "Worker status unknown"}
          </span>
        </div>
        <div>
          <button onClick={() => void fetchJobs()} disabled={loadingJobs}><RefreshCw size={12} className={loadingJobs ? "spin" : ""} /> Refresh</button>
        </div>
      </div>
      {dbJobs.length
          ? <div className="durable-jobs-list">
              {dbJobs.map((job) => <div key={job.id} className="durable-job">
                <div>
                  <strong>{job.sender}</strong>
                  <span> · {job.filename || job.subject}</span>
                  <small>{new Date(job.created_at).toLocaleString("en-AU")}{job.attempts > 1 ? ` · attempt ${job.attempts}` : ""}</small>
                  {job.error ? <small className="durable-job-error">{job.error}</small> : null}
                </div>
                <div>
                  <span>{job.report_count} / {job.row_count} reports</span>
                  {job.review_count > 0 ? <span className="review-count">{job.review_count} to review</span> : null}
                  <span className={`batch-status ${job.status}`}>{job.status.replace(/_/g, " ")}</span>
                </div>
              </div>)}
            </div>
          : <p className="durable-jobs-empty">No jobs recorded yet. Queue a CSV with Auto-pilot or email one to the bot mailbox.</p>}
    </div>
    {rows.length ? <><div className="batch-stats"><div><span>Rows</span><strong>{rows.length}</strong></div><div><span>Ready</span><strong>{counts.ready || 0}</strong></div><div><span>Review</span><strong>{counts.review || 0}</strong></div><div><span>Completed</span><strong>{complete}</strong></div><button onClick={() => void processBatch()} disabled={!ready || loadingFile}>{ready ? "Generate " + ready + " report" + (ready === 1 ? "" : "s") : "No approved reports"} <ArrowRight size={16} /></button></div>
      <div className="batch-ledger"><div className="batch-ledger-heading"><span>CSV row</span><span>Original input</span><span>Match decision</span><span>Report status</span></div>{rows.map((row) => <article key={row.id}><span className="batch-row-number">{row.rowNumber || "!"}</span><div className="batch-address"><strong>{row.originalAddress || "CSV format error"}</strong>{row.normalizedAddress && row.normalizedAddress !== row.originalAddress ? <small>Normalized: {row.normalizedAddress}</small> : null}</div><div className="batch-match"><span className={"batch-status " + row.status}>{row.status === "complete" || row.status === "ready" ? <Check size={13} /> : row.status === "matching" || row.status === "processing" ? <LoaderCircle className="spin" size={13} /> : <CircleDashed size={13} />}{row.status}</span><p>{row.note}</p>{row.status === "review" ? <div className="batch-suggestions">{row.suggestions.map((suggestion, index) => <button key={String(suggestion.propertyId) + "-" + index} onClick={() => approve(row, suggestion)}><Search size={13} />{suggestion.suggestion}</button>)}</div> : null}</div><div className="batch-output">{row.status === "complete" && row.report ? <><button onClick={() => saveFile("parcel-atlas-" + row.propertyId + ".html", row.report || "")}><FileText size={14} />Download HTML</button><button className="pdf-button" onClick={() => saveAsPdf(row.report || "")}><Printer size={14} />Save as PDF</button></> : row.status === "failed" ? <span className="batch-error">{row.error}</span> : <span>—</span>}</div></article>)}</div>
      {complete ? <div className="batch-export"><span>{complete} HTML report{complete === 1 ? "" : "s"} ready in this browser session.</span><button onClick={() => saveFile("parcel-atlas-batch-index.html", "<!doctype html><title>Parcel Atlas batch</title><h1>Parcel Atlas batch reports</h1><p>Generated " + new Date().toLocaleString("en-AU") + "</p>")}>Download batch index <ArrowRight size={15} /></button></div> : null}
    </> : <div className="batch-empty"><Search size={21} /><span>Upload a CSV to start address validation and report preparation.</span></div>}
  </section>;
}
