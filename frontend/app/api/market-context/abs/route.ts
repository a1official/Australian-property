import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const postcode = request.nextUrl.searchParams.get("postcode")?.trim() ?? "";
  if (!/^\d{4}$/.test(postcode)) {
    return NextResponse.json(
      { detail: "Enter a four-digit Australian postcode." },
      { status: 400 },
    );
  }

  const baseUrl = process.env.REA_API_BASE_URL ?? "http://127.0.0.1:8000";
  const upstreamUrl = new URL("/api/v1/market-context/abs", baseUrl);
  upstreamUrl.searchParams.set("postcode", postcode);

  try {
    const response = await fetch(upstreamUrl, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json();
    return NextResponse.json(payload, { status: response.status });
  } catch {
    return NextResponse.json(
      { detail: "The ABS market-context service is temporarily unavailable." },
      { status: 502 },
    );
  }
}
