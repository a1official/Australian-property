import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { gmailAuthorisationUrl } from "@/lib/gmail";

export const runtime = "nodejs";

export async function GET() {
  try {
    const state = randomUUID();
    const store = await cookies();
    store.set("parcel-atlas-gmail-state", state, { httpOnly: true, sameSite: "lax", maxAge: 600, path: "/" });
    return Response.redirect(await gmailAuthorisationUrl(state));
  } catch (error) {
    return Response.json({ detail: error instanceof Error ? error.message : "Gmail connection could not start." }, { status: 400 });
  }
}
