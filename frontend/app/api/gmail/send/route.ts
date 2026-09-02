import { cookies } from "next/headers";
import { authoriseLocalGmailAction, sendReports } from "@/lib/gmail";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    await authoriseLocalGmailAction((await cookies()).get("parcel-atlas-gmail-local-action")?.value);
    const input = await request.json() as { recipient?: string; subject?: string; reports?: Array<{ fileName?: string; html?: string }>; sourceMessageId?: string };
    const reports = (input.reports || []).flatMap((report) => report.fileName && report.html ? [{ fileName: report.fileName, html: report.html }] : []);
    if (!input.recipient || !input.subject) throw new Error("Recipient and subject are required.");
    await sendReports({ recipient: input.recipient, subject: input.subject, reports, sourceMessageId: input.sourceMessageId });
    return Response.json({ sent: true });
  } catch (error) {
    return Response.json({ detail: error instanceof Error ? error.message : "Reports could not be sent." }, { status: 400 });
  }
}
