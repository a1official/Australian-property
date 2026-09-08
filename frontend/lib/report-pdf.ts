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

function value(value: unknown): string {
  return value === null || value === undefined || value === "" ? "Not available" : String(value);
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
  if (doc.y + height <= PAGE_HEIGHT - PAGE_MARGIN) return;
  doc.addPage();
  doc.y = PAGE_MARGIN;
}

function drawHeader(doc: PDFKit.PDFDocument, address: string, now: Date): void {
  doc.rect(0, 0, PAGE_WIDTH, 145).fill("#172022");
  doc.fillColor("#D7FF45").font("Helvetica").fontSize(7).text("PARCEL ATLAS / PROPERTY REPORT", PAGE_MARGIN, 35, { characterSpacing: 1.2 });
  doc.fillColor("#FFFFFF").font("Times-Roman").fontSize(26).text(address, PAGE_MARGIN, 54, { width: CONTENT_WIDTH, lineGap: 2 });
  doc.fillColor("#C7D0CD").font("Helvetica").fontSize(8).text(`Generated ${dateStamp(now)} - Cotality evidence`, PAGE_MARGIN, 119);
  doc.y = 168;
}

function drawFactGrid(doc: PDFKit.PDFDocument, facts: Array<[string, unknown]>): void {
  const columnWidth = CONTENT_WIDTH / 3;
  const rowHeight = 49;
  const startY = doc.y;
  facts.forEach(([label, factValue], index) => {
    const column = index % 3;
    const row = Math.floor(index / 3);
    const x = PAGE_MARGIN + column * columnWidth;
    const y = startY + row * rowHeight;
    doc.rect(x, y, columnWidth - 2, rowHeight - 2).fillAndStroke("#FFFFFF", "#E5E1D6");
    doc.fillColor("#667070").font("Helvetica").fontSize(6.5).text(label.toUpperCase(), x + 8, y + 8, { width: columnWidth - 16 });
    doc.fillColor("#172022").font("Times-Roman").fontSize(12).text(value(factValue), x + 8, y + 20, { width: columnWidth - 16, height: 23, ellipsis: true });
  });
  doc.y = startY + Math.ceil(facts.length / 3) * rowHeight + 14;
}

function drawComparable(doc: PDFKit.PDFDocument, candidate: ReportCandidate, index: number, imageSource: string | undefined): void {
  const cardHeight = 110;
  ensureSpace(doc, cardHeight + 10);
  const y = doc.y;
  doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, cardHeight).fillAndStroke("#FFFFFF", "#E5E1D6");
  doc.rect(PAGE_MARGIN, y, 44, cardHeight).fill("#172022");
  doc.fillColor("#D7FF45").font("Times-Roman").fontSize(22).text(value(record(candidate.score).total), PAGE_MARGIN, y + 35, { width: 44, align: "center" });

  const image = dataUriBuffer(imageSource);
  const imageX = PAGE_MARGIN + 54;
  if (image) {
    try { doc.image(image, imageX, y + 10, { fit: [105, 90], align: "center", valign: "center" }); } catch { /* image is optional */ }
  }
  const textX = imageX + 116;
  const score = record(candidate.score);
  const breakdown = record(score.breakdown);
  const distance = candidate.distanceKm === null ? "Distance unavailable" : `${candidate.distanceKm} km from reference`;
  doc.fillColor("#FF6940").font("Helvetica").fontSize(6.5).text(`COMPARABLE ${String(index + 1).padStart(2, "0")} - PROPERTY ID ${value(candidate.propertyId)}`, textX, y + 12, { characterSpacing: 0.5 });
  doc.fillColor("#172022").font("Times-Roman").fontSize(13).text(value(candidate.address), textX, y + 24, { width: CONTENT_WIDTH - (textX - PAGE_MARGIN) - 10, height: 29, ellipsis: true });
  doc.fillColor("#52605C").font("Helvetica").fontSize(7.3).text(`${value(candidate.propertyType)} - ${value(candidate.beds)} bed - ${value(candidate.baths)} bath - ${value(candidate.carSpaces)} car\n${distance}\nWeekly rent: ${formatMoney(candidate.weeklyRent)} / week`, textX, y + 53, { width: CONTENT_WIDTH - (textX - PAGE_MARGIN) - 10, lineGap: 2 });
  doc.fillColor("#667070").font("Helvetica").fontSize(6.4).text(`Score: type ${value(breakdown.type)} - beds ${value(breakdown.bedrooms)} - baths ${value(breakdown.bathrooms)} - location ${value(breakdown.location)}`, textX, y + 93, { width: CONTENT_WIDTH - (textX - PAGE_MARGIN) - 10, ellipsis: true });
  doc.y = y + cardHeight + 9;
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

  document.addPage();
  const propertyAddress = value(location.singleLine || input.address);
  drawHeader(document, propertyAddress, now);
  const hero = dataUriBuffer(images.get(heroUrl));
  if (hero) {
    try { document.image(hero, PAGE_MARGIN, document.y, { fit: [CONTENT_WIDTH, 210], align: "center" }); document.y += 220; } catch { /* image is optional */ }
  }
  const facts: Array<[string, unknown]> = [
    ["Type", core.propertyType], ["Bedrooms", core.beds], ["Bathrooms", core.baths], ["Car spaces", core.carSpaces],
    ["Land area", core.landArea ? `${core.landArea} m2` : null], ["Floor area", additional.floorArea ? `${additional.floorArea} m2` : null],
    ["Locality", locality.singleLine], ["Council", location.councilArea], ["Property ID", property.propertyId],
    ["Consumer AVM", formatMoney(findValue(record(modules.avm).data, ["estimate", "avmEstimate", "consumerAvmEstimate", "estimatedValue", "value", "amount"]))],
    ["Rental AVM", formatMoney(findValue(record(modules.rentalAvm).data, ["rentalAvmEstimate", "estimate", "estimatedRent", "rent", "amount"]))],
    ["Last sale", formatMoney(findValue(lastSale, ["price", "salePrice", "saleAmount", "amount"]))],
  ];
  drawFactGrid(document, facts);
  ensureSpace(document, 100);
  document.fillColor("#172022").font("Times-Roman").fontSize(22).text("Similar homes", PAGE_MARGIN, document.y);
  document.fillColor("#465250").font("Helvetica").fontSize(8.5).text("Only matches scoring 60/100 or above with confirmed weekly rental data are included.", PAGE_MARGIN, document.y + 6, { width: CONTENT_WIDTH, lineGap: 2 });
  const average = averageWeeklyRentOf(selected);
  if (average !== null) {
    const summaryY = document.y + 18;
    document.rect(PAGE_MARGIN, summaryY, CONTENT_WIDTH, 49).fill("#172022");
    document.fillColor("#C7D0CD").font("Helvetica").fontSize(7).text("AVERAGE WEEKLY RENT", PAGE_MARGIN + 12, summaryY + 10);
    document.fillColor("#D7FF45").font("Times-Roman").fontSize(20).text(`${formatMoney(average)} / week`, PAGE_MARGIN + 12, summaryY + 20);
    document.y = summaryY + 63;
  }
  if (rentQuality.excluded.length) {
    ensureSpace(document, 42);
    document.rect(PAGE_MARGIN, document.y, CONTENT_WIDTH, 34).fill("#FFF0C7");
    document.fillColor("#5F4A18").font("Helvetica").fontSize(7.5).text(`Rent-quality check excluded ${rentQuality.excluded.length} comparable(s) with missing, implausible, or market-outlier weekly rent.`, PAGE_MARGIN + 10, document.y + 10, { width: CONTENT_WIDTH - 20 });
    document.y += 46;
  }
  if (selected.length) {
    document.addPage();
    document.y = PAGE_MARGIN;
    document.fillColor("#172022").font("Times-Roman").fontSize(22).text("Comparable properties", PAGE_MARGIN, document.y);
    document.y += 10;
    selected.forEach((candidate, index) => drawComparable(document, candidate, index, typeof candidate.imageUrl === "string" ? images.get(candidate.imageUrl) : undefined));
  }
  ensureSpace(document, 58);
  const reference = record(record(input.comparables).reference);
  document.rect(PAGE_MARGIN, document.y, CONTENT_WIDTH, 42).fill("#E8F8D0");
  document.fillColor("#364D22").font("Helvetica").fontSize(7.5).text(`Distance handling: ${reference.coordinateAvailable === true ? "distance is calculated from reference and candidate coordinates." : "the reference coordinate was unavailable, so no distance was invented."}`, PAGE_MARGIN + 10, document.y + 10, { width: CONTENT_WIDTH - 20, lineGap: 2 });
  document.end();
  return { filename: reportPdfFilenameFor(propertyAddress, now), content: await completed };
}
