import "server-only";

import { deleteGmailConnection, getGmailConnection } from "@/lib/db";
import { readOAuthClientConfig, revokeToken } from "@/lib/gmail-oauth";
import { createLogger } from "@/lib/logger";
import { decryptSecret } from "@/lib/token-crypto";

export const runtime = "nodejs";
export const maxDuration = 20;

const log = createLogger({ route: "gmail/oauth/disconnect" });

/**
 * Disconnects the mailbox: revokes the grant at Google where possible, then
 * clears the stored token so no encrypted credential is retained.
 */
export async function POST() {
  try {
    const connection = await getGmailConnection();

    if (connection?.refresh_token_encrypted) {
      try {
        readOAuthClientConfig();
        await revokeToken(decryptSecret(connection.refresh_token_encrypted));
      } catch {
        // Revocation is best effort. Local removal must still proceed, or a
        // stale grant would linger in the database.
        log.warn("oauth.revoke_skipped");
      }
    }

    await deleteGmailConnection();
    log.info("oauth.disconnected");
    return Response.json({ ok: true, connected: false, status: "disconnected" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    log.error("oauth.disconnect_failed", { error: error instanceof Error ? error.message : "unknown" });
    return Response.json(
      { ok: false, error: "Gmail could not be disconnected." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
