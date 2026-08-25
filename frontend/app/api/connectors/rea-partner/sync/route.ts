import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  if (process.env.NODE_ENV === "production" && process.env.REA_ENABLE_UI_SYNC !== "true") {
    return NextResponse.json({ detail: "UI-triggered sync is disabled in production." }, { status: 403 });
  }
  const baseUrl = process.env.REA_API_BASE_URL ?? "http://127.0.0.1:8000";
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (process.env.REA_SYNC_ADMIN_TOKEN) headers["X-Admin-Token"] = process.env.REA_SYNC_ADMIN_TOKEN;
  try {
    const response = await fetch(new URL("/api/v1/connectors/rea-partner/sync", baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(await request.json()),
      cache: "no-store",
      signal: AbortSignal.timeout(120_000),
    });
    return NextResponse.json(await response.json(), { status: response.status });
  } catch {
    return NextResponse.json({ detail: "The REA sync did not complete. Check the API logs." }, { status: 502 });
  }
}
