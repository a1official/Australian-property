import { NextResponse } from "next/server";

export async function GET() {
  const baseUrl = process.env.REA_API_BASE_URL ?? "http://127.0.0.1:8000";
  try {
    const response = await fetch(new URL("/api/v1/connectors/rea-partner", baseUrl), {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    return NextResponse.json(await response.json(), { status: response.status });
  } catch {
    return NextResponse.json({ detail: "The connector API is unavailable." }, { status: 502 });
  }
}
