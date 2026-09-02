import {
  DispatchConfigError,
  DispatchFailedError,
  dispatchWorkflow,
  readDispatchConfig,
} from "@/lib/github-dispatch";

export const runtime = "nodejs";
// Dispatch only. The GitHub runner does the long work, so this stays short.
export const maxDuration = 20;

/**
 * Starts one mailbox run by dispatching the GitHub Actions workflow.
 *
 * This route never launches Playwright, reads Gmail, spawns a child process, or
 * calls Cotality. It hands off to the runner and returns immediately, because a
 * workflow dispatch is asynchronous.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { reason?: unknown } | null;

  try {
    const result = await dispatchWorkflow({ reason: body?.reason });
    return Response.json(
      {
        ok: true,
        accepted: true,
        workflow: result.workflow,
        ref: result.ref,
        reason: result.reason,
        // Say plainly that acceptance is not completion.
        detail:
          "GitHub Actions accepted the run. The worker is checking Gmail and processing CSV reports in the background; job status will appear below as Neon records it.",
      },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof DispatchConfigError || error instanceof DispatchFailedError) {
      return Response.json(
        { ok: false, error: error.message },
        { status: error.status, headers: { "Cache-Control": "no-store" } },
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
    const config = readDispatchConfig();
    return Response.json(
      {
        ok: true,
        configured: true,
        owner: config.owner,
        repo: config.repo,
        workflow: config.workflow,
        ref: config.ref,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { ok: true, configured: false },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
