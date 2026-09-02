import { cookies } from "next/headers";
import { authoriseLocalGmailAction, importIncomingCsv } from "@/lib/gmail";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST() {
  try {
    await authoriseLocalGmailAction((await cookies()).get("parcel-atlas-gmail-local-action")?.value);
    return Response.json({ imports: await importIncomingCsv() });
  }
  catch (error) { return Response.json({ detail: error instanceof Error ? error.message : "Gmail sync failed." }, { status: 400 }); }
}
