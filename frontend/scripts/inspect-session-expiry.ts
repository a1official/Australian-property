#!/usr/bin/env tsx
/**
 * Reports Gmail cookie expiry windows so session-lifetime behaviour is based on
 * data rather than assumption. Prints names and dates only, never values.
 */

import { existsSync, readFileSync } from "node:fs";
import * as nodePath from "node:path";

type Cookie = { name: string; domain?: string; expires?: number };

const path = nodePath.resolve(process.cwd(), "..", ".local", "gmail-session.json");
if (!existsSync(path)) {
  console.log("no local session file");
  process.exit(0);
}

const parsed = JSON.parse(readFileSync(path, "utf8")) as { cookies?: Cookie[] };
const cookies = parsed.cookies ?? [];
const now = Date.now() / 1000;

// Cookies Google actually uses to authenticate a Gmail web session.
const authCookies = new Set(["SID", "HSID", "SSID", "APISID", "SAPISID", "__Secure-1PSID", "__Secure-3PSID", "LSID", "COMPASS"]);

const rows = cookies
  .filter((cookie) => authCookies.has(cookie.name))
  .map((cookie) => {
    const expires = cookie.expires && cookie.expires > 0 ? cookie.expires : null;
    return {
      name: cookie.name,
      session: expires === null,
      expiresAt: expires ? new Date(expires * 1000).toISOString() : "session-only",
      daysLeft: expires ? Math.round(((expires - now) / 86_400) * 10) / 10 : null,
    };
  })
  .sort((left, right) => (left.daysLeft ?? -1) - (right.daysLeft ?? -1));

console.log(`total cookies: ${cookies.length}, auth-relevant: ${rows.length}\n`);
for (const row of rows) {
  const state = row.daysLeft === null ? "SESSION-ONLY (dies with the browser)" : row.daysLeft < 0 ? `EXPIRED ${Math.abs(row.daysLeft)}d ago` : `${row.daysLeft}d left`;
  console.log(`  ${row.name.padEnd(18)} ${state}`);
}

const expired = rows.filter((row) => row.daysLeft !== null && row.daysLeft < 0).length;
const sessionOnly = rows.filter((row) => row.session).length;
console.log(`\nexpired: ${expired}, session-only: ${sessionOnly}`);
