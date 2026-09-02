import { UnauthorizedError, assertJobApiRequest, unauthorizedResponse } from "@/lib/api-auth";
import { getWorkerHealth } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 15;

const STALE_AFTER_SECONDS = 300;

/** Worker liveness derived from the Neon heartbeat table. */
export async function GET(request: Request) {
  try {
    assertJobApiRequest(request);
    const workers = await getWorkerHealth();
    const live = workers.filter((worker) => Number(worker.seconds_since_seen ?? Infinity) < STALE_AFTER_SECONDS);

    return Response.json(
      {
        ok: true,
        healthy: live.length > 0,
        staleAfterSeconds: STALE_AFTER_SECONDS,
        workers: workers.map((worker) => ({
          workerId: worker.worker_id,
          status: worker.status,
          currentJobId: worker.current_job_id,
          cycles: Number(worker.cycles ?? 0),
          detail: worker.detail,
          lastSeenAt: worker.last_seen_at,
          secondsSinceSeen: Number(worker.seconds_since_seen ?? 0),
          stale: Number(worker.seconds_since_seen ?? Infinity) >= STALE_AFTER_SECONDS,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse(error);
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "Worker health could not be read." },
      { status: 500 },
    );
  }
}
