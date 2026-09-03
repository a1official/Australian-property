import "server-only";

import { getGmailConnectionSummary } from "@/lib/db";
import { readOAuthClientConfig } from "@/lib/gmail-oauth";

export const runtime = "nodejs";
export const maxDuration = 15;

/**
 * Safe connection status for the UI.
 *
 * Returns only a masked address, scope names, status and timestamps. No access
 * token, refresh token, client secret or full mailbox address is ever included.
 */
export async function GET() {
  let configured = true;
  try {
    readOAuthClientConfig();
  } catch {
    configured = false;
  }

  try {
    const summary = await getGmailConnectionSummary();
    if (!summary) {
      return Response.json(
        { ok: true, configured, connected: false, status: "disconnected", email: null },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const status = String(summary.status ?? "disconnected");
    const hasToken = Boolean(summary.has_token);
    return Response.json(
      {
        ok: true,
        configured,
        // Connected means genuinely usable: a stored grant in good standing.
        connected: status === "connected" && hasToken,
        status,
        needsReauthorization: status === "needs_reauthorization",
        email: summary.email_masked ?? null,
        scopes: String(summary.scopes ?? "").split(" ").filter(Boolean),
        connectedAt: summary.connected_at ?? null,
        lastUsedAt: summary.last_used_at ?? null,
        errorCode: summary.error_code ?? null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { ok: false, configured, connected: false, error: "Gmail connection status could not be read." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
