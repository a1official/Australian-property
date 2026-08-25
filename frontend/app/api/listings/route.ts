import { NextRequest, NextResponse } from "next/server";

const allowedParameters = new Set([
  "source",
  "text",
  "suburb",
  "state",
  "postcode",
  "property_type",
  "bedrooms_min",
  "bedrooms_max",
  "bathrooms_min",
  "bathrooms_max",
  "parking_min",
  "weekly_rent_min",
  "weekly_rent_max",
  "sort_by",
  "sort_order",
  "limit",
  "offset",
]);

export async function GET(request: NextRequest) {
  const baseUrl = process.env.REA_API_BASE_URL ?? "http://127.0.0.1:8000";
  const upstreamUrl = new URL("/api/v1/listings", baseUrl);

  request.nextUrl.searchParams.forEach((value, key) => {
    if (allowedParameters.has(key)) {
      upstreamUrl.searchParams.append(key, value);
    }
  });

  try {
    const response = await fetch(upstreamUrl, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json();
    return NextResponse.json(payload, { status: response.status });
  } catch {
    return NextResponse.json(
      {
        detail:
          "The property data API is unavailable. Start rea-api on port 8000 and try again.",
      },
      { status: 502 },
    );
  }
}
