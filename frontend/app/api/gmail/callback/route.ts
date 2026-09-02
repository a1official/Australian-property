import { cookies } from "next/headers";
import { connectGmail } from "@/lib/gmail";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const store = await cookies();
  const expected = store.get("parcel-atlas-gmail-state")?.value;
  if (!code || !state || state !== expected) return Response.redirect(new URL("/?gmail=error#batch-reports", url));
  try {
    const connection = await connectGmail(code);
    store.delete("parcel-atlas-gmail-state");
    store.set("parcel-atlas-gmail-local-action", connection.localActionToken, { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", maxAge: 8 * 60 * 60, path: "/" });
    return Response.redirect(new URL("/?gmail=connected#batch-reports", url));
  } catch {
    return Response.redirect(new URL("/?gmail=error#batch-reports", url));
  }
}
