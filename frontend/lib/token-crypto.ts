/**
 * Authenticated encryption for OAuth refresh tokens at rest.
 *
 * AES-256-GCM, so tampering is detected rather than silently decrypting to
 * garbage. The key is validated eagerly and never logged. Kept free of
 * `server-only` and database imports so it is directly unit testable.
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { runtimeEnv } from "./runtime-env";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = "v1";

export class TokenCryptoError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = "TokenCryptoError";
  }
}

/**
 * Resolves the 32-byte key from GMAIL_TOKEN_ENCRYPTION_KEY.
 *
 * Accepts base64 or hex of exactly 32 bytes, or a passphrase of at least 32
 * characters which is hashed to 32 bytes. A short passphrase is rejected rather
 * than silently stretched, because that would weaken the key without warning.
 */
export function resolveEncryptionKey(raw: string | undefined): Buffer {
  const value = raw?.trim();
  if (!value) {
    throw new TokenCryptoError(
      "GMAIL_TOKEN_ENCRYPTION_KEY is not configured. Gmail cannot be connected without a key to encrypt the refresh token.",
    );
  }

  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, "hex");

  if (/^[A-Za-z0-9+/]{43}=$|^[A-Za-z0-9+/]{44}$/.test(value)) {
    const decoded = Buffer.from(value, "base64");
    if (decoded.length === 32) return decoded;
  }

  if (value.length >= 32) return createHash("sha256").update(value, "utf8").digest();

  throw new TokenCryptoError(
    "GMAIL_TOKEN_ENCRYPTION_KEY is malformed. Provide 32 bytes as hex or base64, or a passphrase of at least 32 characters.",
  );
}

/** Validates the key without revealing it. Call at startup to fail early. */
export function assertEncryptionKeyConfigured(env: NodeJS.ProcessEnv = process.env): void {
  resolveEncryptionKey(runtimeEnv("GMAIL_TOKEN_ENCRYPTION_KEY", env));
}

/** Returns `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
export function encryptSecret(plaintext: string, keySource?: string): string {
  if (!plaintext) throw new TokenCryptoError("Refusing to encrypt an empty value.");
  const key = resolveEncryptionKey(keySource ?? runtimeEnv("GMAIL_TOKEN_ENCRYPTION_KEY"));
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptSecret(payload: string, keySource?: string): string {
  const parts = payload?.split(".") ?? [];
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new TokenCryptoError("Stored token is not in the expected encrypted format.");
  }
  const key = resolveEncryptionKey(keySource ?? runtimeEnv("GMAIL_TOKEN_ENCRYPTION_KEY"));
  const iv = Buffer.from(parts[1], "base64url");
  const tag = Buffer.from(parts[2], "base64url");
  const ciphertext = Buffer.from(parts[3], "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new TokenCryptoError("Stored token has invalid encryption metadata.");
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key or tampered ciphertext are indistinguishable, and both mean the
    // stored grant is unusable. Never echo the payload.
    throw new TokenCryptoError(
      "Stored Gmail token could not be decrypted. The encryption key may have changed; reconnect Gmail.",
    );
  }
}

/** `a***z@example.com` — enough to identify the mailbox, not to disclose it. */
export function maskEmail(email: string): string {
  const trimmed = (email || "").trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return trimmed ? "***" : "";
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const shown = local.length <= 2 ? local.slice(0, 1) : `${local[0]}***${local[local.length - 1]}`;
  return `${shown}@${domain}`;
}
