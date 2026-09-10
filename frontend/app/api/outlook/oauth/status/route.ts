import "server-only";
import { getOutlookConnectionSummary, initSchema } from "@/lib/db";
import { readOutlookOAuthConfig } from "@/lib/outlook-oauth";
export const runtime = "nodejs";
export async function GET() {
  let configured = true; try { readOutlookOAuthConfig(); } catch { configured = false; }
  try { await initSchema(); const summary = await getOutlookConnectionSummary(); const status = String(summary?.status ?? "disconnected"); return Response.json({ ok: true, configured, connected: status === "connected" && Boolean(summary?.has_token), status, needsReauthorization: status === "needs_reauthorization", email: summary?.email_masked ?? null, scopes: String(summary?.scopes ?? "").split(" ").filter(Boolean) }, { headers: { "Cache-Control": "no-store" } }); }
  catch { return Response.json({ ok: false, configured, connected: false, error: "Outlook connection status could not be read." }, { status: 500 }); }
}
