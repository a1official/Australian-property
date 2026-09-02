import { SESSION_COOKIE, jobApiConfigured, sessionCookieValue, verifyToken } from "@/lib/api-auth";

export const runtime = "nodejs";
export const maxDuration = 15;

/**
 * Exchanges the operator token for an httpOnly session cookie so the Auto-pilot
 * UI can call the job endpoints without the token ever reaching client JS.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { token?: string } | null;
  if (!jobApiConfigured()) {
    return Response.json({ ok: false, error: "JOB_API_TOKEN is not configured on the server." }, { status: 503 });
  }
  if (!body?.token || !verifyToken(body.token)) {
    return Response.json({ ok: false, error: "Invalid operator token." }, { status: 401 });
  }

  return Response.json(
    { ok: true },
    {
      headers: {
        "Cache-Control": "no-store",
        "Set-Cookie": [
          `${SESSION_COOKIE}=${sessionCookieValue()}`,
          "Path=/",
          "HttpOnly",
          "SameSite=Strict",
          ...(process.env.NODE_ENV === "production" ? ["Secure"] : []),
          `Max-Age=${8 * 60 * 60}`,
        ].join("; "),
      },
    },
  );
}

export async function GET(request: Request) {
  const hasSession = (request.headers.get("cookie") || "").includes(`${SESSION_COOKIE}=`);
  return Response.json(
    { ok: true, configured: jobApiConfigured(), authenticated: hasSession },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function DELETE() {
  return Response.json(
    { ok: true },
    {
      headers: {
        "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
        "Cache-Control": "no-store",
      },
    },
  );
}
