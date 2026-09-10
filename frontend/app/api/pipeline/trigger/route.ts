import { awsDispatchConfigured, AwsDispatchConfigurationError, dispatchAwsMailboxRun } from "@/lib/aws-dispatch";

export const runtime = "nodejs";
// Dispatch only. AWS SQS/Lambda performs the long-running work.
export const maxDuration = 20;

/**
 * Starts one mailbox run through the private AWS Lambda invocation API.
 *
 * This route never launches Playwright, reads Gmail, spawns a child process, or
 * calls Cotality. It hands off to the runner and returns immediately, because a
 * workflow dispatch is asynchronous.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { reason?: unknown } | null;

  try {
    const result = await dispatchAwsMailboxRun(body?.reason);
    return Response.json(
      {
        ok: true,
        accepted: true,
        discovered: result.discovered,
        // Say plainly that acceptance is not completion.
        detail:
          "AWS accepted the run. The worker is checking Gmail and processing CSV reports in the background; job status will appear below as Neon records it.",
      },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof AwsDispatchConfigurationError) {
      return Response.json(
        { ok: false, error: error.message },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    return Response.json(
      { ok: false, error: "The mailbox run could not be started." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

/** Reports whether dispatching is configured, without revealing the token. */
export async function GET() {
  try {
    return Response.json(
      {
        ok: true,
        configured: awsDispatchConfigured(),
        provider: "aws-lambda",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch { return Response.json({ ok: true, configured: false }, { headers: { "Cache-Control": "no-store" } }); }
}
