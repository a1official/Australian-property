import { gmailStatus } from "@/lib/gmail";

export const runtime = "nodejs";

export async function GET() {
  return Response.json(await gmailStatus(), { headers: { "Cache-Control": "no-store" } });
}
