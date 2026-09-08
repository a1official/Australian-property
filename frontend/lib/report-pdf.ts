import PDFDocument from "pdfkit";

import {
  averageWeeklyRentOf,
  findValue,
  formatMoney,
  record,
  selectQualityComparableRents,
  type ImageEmbedder,
  type ReportCandidate,
} from "./report-html";

const PAGE_MARGIN = 42;
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const BRAND_NAVY = "#203463";
const BRAND_ORANGE = "#EF7C2F";
const INK = "#272B35";
const MUTED = "#687080";

function value(input: unknown): string {
  return input === null || input === undefined || input === "" ? "Not available" : String(input);
}

function dateStamp(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function reportPdfFilenameFor(address: string, now = new Date()): string {
  const slug = address
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 110) || "property-report";
  return `${slug}-${dateStamp(now)}.pdf`;
}

function dataUriBuffer(source: string | undefined): Buffer | null {
  if (!source?.startsWith("data:image/")) return null;
  const comma = source.indexOf(",");
  if (comma < 0) return null;
  try {
    return Buffer.from(source.slice(comma + 1), "base64");
  } catch {
    return null;
  }
}

function ensureSpace(doc: PDFKit.PDFDocument, height: number): void {
  if (doc.y + height <= PAGE_HEIGHT - PAGE_MARGIN - 26) return;
  doc.addPage();
  doc.y = PAGE_MARGIN;
}

/** The requested Murdoch Lee-style masthead. */
function drawHeader(doc: PDFKit.PDFDocument, now: Date, subtitle = "RENT REVIEW REPORT"): void {
  doc.rect(0, 0, PAGE_WIDTH, 54).fill(BRAND_NAVY);
  doc.fillColor("#FFFFFF").font("Helvetica").fontSize(25).text("MURDOCH", PAGE_MARGIN, 13, { characterSpacing: 0.7 });
  doc.fillColor(BRAND_ORANGE).font("Helvetica-Bold").fontSize(25).text("_", PAGE_MARGIN + 137, 13);
  doc.fillColor("#FFFFFF").font("Helvetica").fontSize(25).text("LEE", PAGE_MARGIN + 166, 13, { characterSpacing: 0.7 });
  doc.fillColor("#DCE4F4").font("Helvetica").fontSize(6.8).text(subtitle, PAGE_WIDTH - PAGE_MARGIN - 145, 22, {
    width: 145,
    align: "right",
    characterSpacing: 1.05,
  });
  doc.fillColor(MUTED).font("Helvetica").fontSize(7.3).text(`Prepared ${dateStamp(now)} - Cotality evidence`, PAGE_MARGIN, 72, { characterSpacing: 0.25 });
  doc.y = 94;
}

function drawBrandOverlay(doc: PDFKit.PDFDocument): void {
  doc.fillColor("#FFFFFF").font("Helvetica").fontSize(25).text("MURDOCH", PAGE_MARGIN, 13, { characterSpacing: 0.7 });
  doc.fillColor(BRAND_ORANGE).font("Helvetica-Bold").fontSize(25).text("_", PAGE_MARGIN + 137, 13);
  doc.fillColor("#FFFFFF").font("Helvetica").fontSize(25).text("LEE", PAGE_MARGIN + 166, 13, { characterSpacing: 0.7 });
}

function drawSectionTitle(doc: PDFKit.PDFDocument, eyebrow: string, title: string, copy?: string): void {
  ensureSpace(doc, copy ? 64 : 38);
  doc.fillColor(BRAND_ORANGE).font("Helvetica-Bold").fontSize(6.8).text(eyebrow.toUpperCase(), PAGE_MARGIN, doc.y, { characterSpacing: 1 });
  doc.fillColor(INK).font("Times-Roman").fontSize(22).text(title, PAGE_MARGIN, doc.y + 8);
  if (copy) {
    doc.fillColor(MUTED).font("Helvetica").fontSize(8.2).text(copy, PAGE_MARGIN, doc.y + 7, { width: CONTENT_WIDTH, lineGap: 2 });
  }
  doc.y += copy ? 17 : 8;
}

function drawFactGrid(doc: PDFKit.PDFDocument, facts: Array<[string, unknown]>): void {
  const columns = 3;
  const columnWidth = CONTENT_WIDTH / columns;
  const rowHeight = 52;
  const startY = doc.y;
  facts.forEach(([label, factValue], index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = PAGE_MARGIN + column * columnWidth;
    const y = startY + row * rowHeight;
    doc.rect(x, y, columnWidth - 2, rowHeight - 2).fillAndStroke("#FAFBFC", "#E6E9EE");
    doc.fillColor(MUTED).font("Helvetica").fontSize(5.9).text(label.toUpperCase(), x + 9, y + 9, { width: columnWidth - 18, characterSpacing: 0.45 });
    doc.fillColor(INK).font("Times-Roman").fontSize(11.5).text(value(factValue), x + 9, y + 22, { width: columnWidth - 18, height: 21, ellipsis: true });
  });
  doc.y = startY + Math.ceil(facts.length / columns) * rowHeight + 14;
}

function drawMetricStrip(doc: PDFKit.PDFDocument, metrics: Array<[string, string]>): void {
  ensureSpace(doc, 74);
  const y = doc.y;
  const width = CONTENT_WIDTH / metrics.length;
  doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, 64).fill(BRAND_NAVY);
  metrics.forEach(([label, metric], index) => {
    const x = PAGE_MARGIN + index * width;
    if (index) doc.moveTo(x, y + 10).lineTo(x, y + 54).strokeColor("#5B6D9A").lineWidth(0.5).stroke();
    doc.fillColor("#C9D4E9").font("Helvetica").fontSize(5.9).text(label.toUpperCase(), x + 10, y + 12, { width: width - 18, characterSpacing: 0.45 });
    doc.fillColor(index === metrics.length - 1 ? "#FFD1B3" : "#FFFFFF").font("Times-Roman").fontSize(14).text(metric, x + 10, y + 28, { width: width - 18, ellipsis: true });
  });
  doc.y = y + 80;
}

function drawMissingImage(doc: PDFKit.PDFDocument, x: number, y: number, width: number, height: number): void {
  doc.rect(x, y, width, height).fill("#E9EEF4");
  doc.fillColor("#66768A").font("Helvetica").fontSize(7).text("Property image\nunavailable", x + 8, y + height / 2 - 8, { width: width - 16, align: "center", lineGap: 2 });
}

function drawHero(doc: PDFKit.PDFDocument, imageSource: string | undefined): void {
  const image = dataUriBuffer(imageSource);
  const width = CONTENT_WIDTH;
  const height = 210;
  const y = doc.y;
  doc.rect(PAGE_MARGIN, y, width, height).fill("#E9EEF4");
  if (image) {
    try {
      doc.image(image, PAGE_MARGIN, y, { fit: [width, height], align: "center", valign: "center" });
    } catch {
      drawMissingImage(doc, PAGE_MARGIN, y, width, height);
    }
  } else {
    drawMissingImage(doc, PAGE_MARGIN, y, width, height);
  }
  doc.y = y + height + 18;
}

function areaText(candidate: ReportCandidate): string {
  return candidate.floorArea ? `${String(candidate.floorArea)} m2 floor` : candidate.landArea ? `${String(candidate.landArea)} m2 land` : "Area unavailable";
}

function drawComparable(doc: PDFKit.PDFDocument, candidate: ReportCandidate, index: number, imageSource: string | undefined, now: Date): void {
  const cardHeight = 132;
  if (doc.y + cardHeight + 12 > PAGE_HEIGHT - PAGE_MARGIN - 26) {
    doc.addPage();
    drawHeader(doc, now, "COMPARABLE PROPERTY EVIDENCE");
    doc.fillColor(MUTED).font("Helvetica").fontSize(7.2).text("Comparable properties continued", PAGE_MARGIN, doc.y, { characterSpacing: 0.3 });
    doc.y += 13;
  }
  const y = doc.y;
  const score = record(candidate.score);
  const breakdown = record(score.breakdown);
  const imageX = PAGE_MARGIN + 54;
  const imageWidth = 114;
  const imageHeight = 112;
  const textX = imageX + imageWidth + 12;
  const textWidth = CONTENT_WIDTH - (textX - PAGE_MARGIN) - 12;
  const image = dataUriBuffer(imageSource);
  doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, cardHeight).fillAndStroke("#FFFFFF", "#E2E6EC");
  doc.rect(PAGE_MARGIN, y, 44, cardHeight).fill(BRAND_NAVY);
  doc.fillColor("#CFEF69").font("Helvetica").fontSize(6).text("MATCH", PAGE_MARGIN + 4, y + 35, { width: 36, align: "center", characterSpacing: 0.4 });
  doc.fillColor("#FFFFFF").font("Times-Roman").fontSize(21).text(value(score.total), PAGE_MARGIN, y + 46, { width: 44, align: "center" });
  doc.fillColor("#B9C4DD").font("Helvetica").fontSize(6).text("/ 100", PAGE_MARGIN, y + 72, { width: 44, align: "center" });
  if (image) {
    try { doc.image(image, imageX, y + 10, { fit: [imageWidth, imageHeight], align: "center", valign: "center" }); } catch { drawMissingImage(doc, imageX, y + 10, imageWidth, imageHeight); }
  } else {
    drawMissingImage(doc, imageX, y + 10, imageWidth, imageHeight);
  }
  const distance = candidate.distanceKm === null ? `Distance unavailable - same locality #${String(candidate.localityId || "Not available")}` : `${candidate.distanceKm} km from reference`;
  doc.fillColor(BRAND_ORANGE).font("Helvetica-Bold").fontSize(6.2).text(`COMPARABLE ${String(index + 1).padStart(2, "0")} - PROPERTY ID ${value(candidate.propertyId)}`, textX, y + 11, { characterSpacing: 0.45 });
  doc.fillColor(INK).font("Times-Roman").fontSize(12.2).text(value(candidate.address), textX, y + 23, { width: textWidth, height: 28, ellipsis: true });
  doc.fillColor("#52606C").font("Helvetica").fontSize(7).text(`${value(candidate.propertyType)} - ${value(candidate.beds)} bed - ${value(candidate.baths)} bath - ${value(candidate.carSpaces)} car - ${areaText(candidate)}\n${distance}\nWeekly rent: ${formatMoney(candidate.weeklyRent)} / week`, textX, y + 52, { width: textWidth, lineGap: 1.7 });
  doc.fillColor("#69737F").font("Helvetica").fontSize(5.9).text(`Score: Type ${value(breakdown.type)} - Beds ${value(breakdown.bedrooms)} - Baths ${value(breakdown.bathrooms)} - Cars ${value(breakdown.cars)} - Area ${value(breakdown.area)} - Location ${value(breakdown.location)}`, textX, y + 109, { width: textWidth, ellipsis: true });
  doc.y = y + cardHeight + 10;
}

export async function buildReportPdf(input: {
  address: string;
  profile: unknown;
  comparables: unknown;
  embedImages?: ImageEmbedder;
  now?: Date;
}): Promise<{ filename: string; content: Buffer }> {
  const now = input.now ?? new Date();
  const property = record(input.profile);
  const modules = record(property.modules);
  const core = record(record(modules.core).data);
  const additional = record(record(modules.additional).data);
  const location = record(record(modules.location).data);
  const locality = record(location.locality);
  const lastSale = record(record(modules.lastSale).data);
  const defaultImage = record(record(record(modules.images).data).defaultImage);
  const heroUrl = typeof defaultImage.largePhotoUrl === "string" ? defaultImage.largePhotoUrl : typeof defaultImage.mediumPhotoUrl === "string" ? defaultImage.mediumPhotoUrl : "";
  const candidates = Array.isArray(record(input.comparables).candidates) ? record(input.comparables).candidates as ReportCandidate[] : [];
  const rentQuality = selectQualityComparableRents(candidates);
  const selected = rentQuality.selected;
  const sources = [heroUrl, ...selected.map((candidate) => typeof candidate.imageUrl === "string" ? candidate.imageUrl : null)];
  const images = input.embedImages ? await input.embedImages(sources) : new Map<string, string>();
  const document = new PDFDocument({ autoFirstPage: false, margin: PAGE_MARGIN, size: "A4" });
  const chunks: Buffer[] = [];
  document.on("data", (chunk: Buffer) => chunks.push(chunk));
  const completed = new Promise<Buffer>((resolve, reject) => {
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
  });

  const propertyAddress = value(location.singleLine || input.address);
  const avm = formatMoney(findValue(record(modules.avm).data, ["estimate", "avmEstimate", "consumerAvmEstimate", "estimatedValue", "value", "amount"]));
  const rentalAvm = formatMoney(findValue(record(modules.rentalAvm).data, ["rentalAvmEstimate", "estimate", "estimatedRent", "rent", "amount"]));
  const salePrice = formatMoney(findValue(lastSale, ["price", "salePrice", "saleAmount", "amount"]));
  const saleDate = findValue(lastSale, ["date", "saleDate", "contractDate", "settlementDate"]);
  const average = averageWeeklyRentOf(selected);
  const reference = record(record(input.comparables).reference);

  document.addPage();
  drawHeader(document, now);
  drawHero(document, images.get(heroUrl));
  document.fillColor(INK).font("Times-Roman").fontSize(23).text(propertyAddress, PAGE_MARGIN, document.y, { width: CONTENT_WIDTH, lineGap: 2 });
  document.y += 13;
  drawFactGrid(document, [
    ["Type", core.propertyType], ["Bedrooms", core.beds], ["Bathrooms", core.baths],
    ["Car spaces", core.carSpaces], ["Land area", core.landArea ? `${core.landArea} m2` : null], ["Floor area", additional.floorArea ? `${additional.floorArea} m2` : null],
    ["Locality", locality.singleLine], ["Locality ID", locality.id], ["Council", location.councilArea],
    ["Property ID", property.propertyId], ["Last sale", salePrice], ["Sale date", saleDate],
    ["Data modules", Object.keys(modules).length],
  ]);
  drawMetricStrip(document, [
    ["Consumer AVM", avm], ["Rental AVM", rentalAvm], ["Last sale", salePrice], ["Average rent", average === null ? "Not available" : `${formatMoney(average)} / wk`],
  ]);
  document.addPage();
  drawHeader(document, now, "COMPARABLE PROPERTY EVIDENCE");
  // Repeat the wordmark after moving to the evidence page so it remains present
  // on PDF readers that defer the first text operation on a newly created page.
  drawBrandOverlay(document);
  document.y = 94;
  drawSectionTitle(document, "Comparable engine", "Similar homes", "Candidates come from the exact Cotality locality, are enriched, and are ranked with the configured 100-point similarity score.");
  if (average !== null) {
    ensureSpace(document, 62);
    const y = document.y;
    document.rect(PAGE_MARGIN, y, CONTENT_WIDTH, 50).fill("#EAF2DF");
    document.fillColor("#5F712D").font("Helvetica-Bold").fontSize(6.5).text("AVERAGE WEEKLY RENT", PAGE_MARGIN + 12, y + 10, { characterSpacing: 0.55 });
    document.fillColor(BRAND_NAVY).font("Times-Roman").fontSize(19).text(`${formatMoney(average)} / week`, PAGE_MARGIN + 12, y + 22);
    document.fillColor("#52606C").font("Helvetica").fontSize(7.2).text(`Calculated from ${selected.length} qualifying comparable${selected.length === 1 ? "" : "s"}`, PAGE_WIDTH - PAGE_MARGIN - 170, y + 22, { width: 170, align: "right" });
    document.y = y + 65;
  }
  if (rentQuality.excluded.length) {
    ensureSpace(document, 50);
    const y = document.y;
    document.rect(PAGE_MARGIN, y, CONTENT_WIDTH, 37).fill("#FFF0C7");
    document.fillColor("#5F4A18").font("Helvetica").fontSize(7.1).text(`Rent-quality check excluded ${rentQuality.excluded.length} comparable(s) with missing, implausible, or market-outlier weekly rent before the average was calculated.`, PAGE_MARGIN + 11, y + 11, { width: CONTENT_WIDTH - 22, lineGap: 2 });
    document.y = y + 49;
  }

  drawSectionTitle(document, "Qualified candidates", "Comparable properties", "Included only where the similarity score is at least 60/100 and weekly rent passes the report quality checks.");
  if (selected.length) {
    selected.forEach((candidate, index) => drawComparable(document, candidate, index, typeof candidate.imageUrl === "string" ? images.get(candidate.imageUrl) : undefined, now));
  } else {
    document.fillColor(MUTED).font("Helvetica").fontSize(9).text("No comparable properties met the score and rent-quality requirements.", PAGE_MARGIN, document.y + 10);
    document.y += 34;
  }
  ensureSpace(document, 86);
  const noteY = document.y;
  document.rect(PAGE_MARGIN, noteY, CONTENT_WIDTH, 72).fill("#F0F4F8");
  const distanceText = reference.coordinateAvailable === true
    ? "Distance is calculated from reference and candidate latitude/longitude using the Haversine formula."
    : "The reference property has no usable Cotality coordinate, so no distance is invented and the exact-locality fallback score is used.";
  document.fillColor(BRAND_NAVY).font("Helvetica-Bold").fontSize(6.5).text("METHOD AND DATA COVERAGE", PAGE_MARGIN + 12, noteY + 11, { characterSpacing: 0.6 });
  document.fillColor("#475464").font("Helvetica").fontSize(7.1).text(`${distanceText}\n\nComparable inclusion: score 60/100 or higher, confirmed weekly rent, and rent-quality validation. Score weights: type 35 - bedrooms 20 - bathrooms 15 - car spaces 10 - floor/land area 10 - locality or distance 10.`, PAGE_MARGIN + 12, noteY + 23, { width: CONTENT_WIDTH - 24, lineGap: 2 });
  document.y = noteY + 84;
  document.end();
  return { filename: reportPdfFilenameFor(input.address, now), content: await completed };
}
