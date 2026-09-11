#!/usr/bin/env tsx
/**
 * Reports which completeness gate rejects a direct property payload.
 *
 * loadDirectSummary returns null when the entitlement-filtered response lacks a
 * required field, which silently sends the caller into the paged street scan.
 * One request per property; read-only.
 */

import { existsSync, readFileSync } from "node:fs";
import * as nodePath from "node:path";

for (const candidate of [
  nodePath.resolve(process.cwd(), "..", ".env"),
  nodePath.resolve(process.cwd(), ".env"),
  nodePath.resolve(process.cwd(), ".env.local"),
]) {
  if (!existsSync(candidate)) continue;
  for (const line of readFileSync(candidate, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
}

import { corelogicRequest } from "../lib/corelogic";
import { record } from "../lib/report-html";

async function main(): Promise<void> {
const ids = process.argv.slice(2);
if (!ids.length) {
  console.error("usage: diagnose-direct-summary.ts <propertyId> [...]");
  process.exit(1);
}

for (const id of ids) {
  const response = await corelogicRequest(`/property/au/v1/property/${encodeURIComponent(id)}.json`, { ttlSeconds: 900 });
  console.log(`\nproperty ${id}: HTTP ${response.status}`);
  if (!response.ok) {
    console.log(`  message: ${response.message ?? "(none)"}`);
    continue;
  }

  const property = record(record(response.data).property);
  const attributes = record(property.attributes);
  const address = record(property.address);
  const photos = property.propertyPhotoList;
  const photo = Array.isArray(photos)
    ? record(photos.find((item) => record(item).isDefaultPhoto === true) ?? photos[0])
    : record(property.propertyPhoto);
  const directCoordinate = record(property.coordinate);

  const gates = {
    "id matches": Number(property.id) === Number(id),
    propertyType: Boolean(property.propertyType ?? property.propertySubType),
    "configuration (beds/baths/cars)": [
      attributes.bedrooms ?? attributes.beds,
      attributes.bathrooms ?? attributes.baths,
      attributes.carSpaces ?? attributes.lockUpGarages,
    ].some((field) => field !== null && field !== undefined),
    coordinate: directCoordinate.latitude !== undefined && directCoordinate.longitude !== undefined,
    "location (localityId + streetId)":
      record(record(address.street).locality).id !== undefined && record(address.street).id !== undefined,
    photo:
      typeof photo.largePhotoUrl === "string" ||
      typeof photo.mediumPhotoUrl === "string" ||
      typeof photo.thumbnailPhotoUrl === "string",
  };

  for (const [name, pass] of Object.entries(gates)) console.log(`  ${pass ? "ok  " : "FAIL"} ${name}`);
  console.log(`  top-level keys: ${Object.keys(record(response.data)).join(", ") || "(none)"}`);
  console.log(`  property keys:  ${Object.keys(property).join(", ") || "(none)"}`);
  console.log(`  verdict: ${Object.values(gates).every(Boolean) ? "direct summary usable" : "falls back to street scan"}`);
}
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
