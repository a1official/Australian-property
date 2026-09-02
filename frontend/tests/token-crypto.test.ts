/**
 * Verifies refresh-token encryption at rest and email masking.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";

import {
  TokenCryptoError,
  assertEncryptionKeyConfigured,
  decryptSecret,
  encryptSecret,
  maskEmail,
  resolveEncryptionKey,
} from "../lib/token-crypto";

const HEX_KEY = randomBytes(32).toString("hex");
const BASE64_KEY = randomBytes(32).toString("base64");
const PASSPHRASE = "a-sufficiently-long-passphrase-value";

test("a 32-byte hex key is accepted", () => {
  assert.equal(resolveEncryptionKey(HEX_KEY).length, 32);
});

test("a 32-byte base64 key is accepted", () => {
  assert.equal(resolveEncryptionKey(BASE64_KEY).length, 32);
});

test("a long passphrase is hashed to a 32-byte key", () => {
  assert.equal(resolveEncryptionKey(PASSPHRASE).length, 32);
});

test("a missing key fails safely with an actionable message", () => {
  assert.throws(() => resolveEncryptionKey(undefined), (error: unknown) =>
    error instanceof TokenCryptoError && /GMAIL_TOKEN_ENCRYPTION_KEY/.test(error.message));
});

test("a short key is rejected rather than silently stretched", () => {
  assert.throws(() => resolveEncryptionKey("too-short"), TokenCryptoError);
});

test("startup validation surfaces a malformed key", () => {
  assert.throws(() => assertEncryptionKeyConfigured({ GMAIL_TOKEN_ENCRYPTION_KEY: "x" } as unknown as NodeJS.ProcessEnv), TokenCryptoError);
  assert.doesNotThrow(() =>
    assertEncryptionKeyConfigured({ GMAIL_TOKEN_ENCRYPTION_KEY: HEX_KEY } as unknown as NodeJS.ProcessEnv));
});

test("a refresh token round-trips through encryption", () => {
  const token = "1//0gRefreshTokenExampleValue";
  const encrypted = encryptSecret(token, HEX_KEY);
  assert.equal(decryptSecret(encrypted, HEX_KEY), token);
});

test("the ciphertext never contains the plaintext", () => {
  const token = "1//0gRefreshTokenExampleValue";
  const encrypted = encryptSecret(token, HEX_KEY);
  assert.ok(!encrypted.includes(token));
  assert.match(encrypted, /^v1\./);
});

test("encrypting the same token twice yields different ciphertexts", () => {
  // A fresh IV each time prevents ciphertext equality leaking token equality.
  assert.notEqual(encryptSecret("same-token-value", HEX_KEY), encryptSecret("same-token-value", HEX_KEY));
});

test("decrypting with the wrong key fails instead of returning garbage", () => {
  const encrypted = encryptSecret("token", HEX_KEY);
  assert.throws(() => decryptSecret(encrypted, randomBytes(32).toString("hex")), TokenCryptoError);
});

test("tampered ciphertext is detected by the auth tag", () => {
  const encrypted = encryptSecret("token", HEX_KEY);
  const parts = encrypted.split(".");
  parts[3] = Buffer.from("tampered-content").toString("base64url");
  assert.throws(() => decryptSecret(parts.join("."), HEX_KEY), TokenCryptoError);
});

test("a malformed payload is rejected", () => {
  for (const bad of ["", "not-encrypted", "v2.a.b.c", "v1.only-two-parts"]) {
    assert.throws(() => decryptSecret(bad, HEX_KEY), TokenCryptoError);
  }
});

test("encrypting an empty value is refused", () => {
  assert.throws(() => encryptSecret("", HEX_KEY), TokenCryptoError);
});

test("email masking hides the local part but keeps the domain", () => {
  assert.equal(maskEmail("akashcoddes@gmail.com"), "a***s@gmail.com");
  assert.equal(maskEmail("ab@example.com"), "a@example.com");
  assert.equal(maskEmail(""), "");
  assert.equal(maskEmail("not-an-email"), "***");
});

test("a masked address never contains the full local part", () => {
  const masked = maskEmail("verylongmailboxname@example.com");
  assert.ok(!masked.includes("verylongmailboxname"));
});
