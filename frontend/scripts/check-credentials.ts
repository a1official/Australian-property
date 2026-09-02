#!/usr/bin/env tsx
/**
 * Confirms the Gmail credentials are actually loaded from the environment.
 * Reports presence, length and shape only. Never prints a secret value.
 */

import { existsSync, readFileSync } from "node:fs";
import * as nodePath from "node:path";

function loadLocalEnv(): void {
  for (const candidate of [
    nodePath.resolve(process.cwd(), "..", ".env"),
    nodePath.resolve(process.cwd(), ".env"),
    nodePath.resolve(process.cwd(), ".env.local"),
  ]) {
    if (!existsSync(candidate)) continue;
    for (const line of readFileSync(candidate, "utf8").split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  }
}

loadLocalEnv();

function describe(key: string): string {
  const value = process.env[key];
  if (value === undefined) return "MISSING";
  if (value === "") return "EMPTY STRING";
  if (value.trim() !== value) return `present, length ${value.length} — WARNING: has surrounding whitespace`;
  return `present, length ${value.length}`;
}

console.log("Gmail credential check (values never printed)\n");
for (const key of ["GMAIL_USERNAME", "GMAIL_PASSWORD", "GMAIL_ALLOWED_SENDERS", "BROWSERLESS_API_KEY", "BROWSERLESS_WS_ENDPOINT"]) {
  console.log(`  ${key.padEnd(24)} ${describe(key)}`);
}

const username = process.env.GMAIL_USERNAME ?? "";
const password = process.env.GMAIL_PASSWORD ?? "";

console.log("\nShape checks:");
console.log(`  username looks like an email:   ${/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(username)}`);
console.log(`  username domain:                ${username.includes("@") ? username.split("@")[1] : "n/a"}`);
// A 16-character all-lowercase password is almost always a Google App Password,
// which behaves very differently from an account password in a browser login.
const compact = password.replace(/\s+/g, "");
const looksLikeAppPassword = compact.length === 16 && /^[a-z]+$/.test(compact);
console.log(`  password length (spaces removed): ${compact.length}`);
console.log(`  looks like a Google App Password: ${looksLikeAppPassword}`);
if (looksLikeAppPassword) {
  console.log("\n  NOTE: App Passwords are for IMAP/SMTP, not the web sign-in form.");
  console.log("        A browser login with one will always be refused.");
}
