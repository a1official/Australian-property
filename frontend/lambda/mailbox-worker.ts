/**
 * AWS Lambda entry point for one Parcel Atlas mailbox-worker cycle.
 *
 * Configure this handler on an EventBridge schedule (for example,
 * `rate(5 minutes)`) or invoke it from an authenticated operator endpoint.
 * The worker itself uses Neon leases and idempotency keys, so concurrent or
 * retried Lambda invocations cannot process the same job twice.
 */
import { runWorkerOnce } from "../scripts/render-worker";

type LambdaContext = { awsRequestId?: string; getRemainingTimeInMillis?: () => number };

export async function handler(event: unknown, context: LambdaContext = {}) {
  const startedAt = Date.now();

  try {
    const result = await runWorkerOnce();
    return {
      ok: true,
      didWork: result.didWork,
      cycles: result.cycles,
      requestId: context.awsRequestId ?? null,
      elapsedMs: Date.now() - startedAt,
      remainingMs: context.getRemainingTimeInMillis?.() ?? null,
      // Keep the event out of logs and responses: scheduled events can carry
      // arbitrary operator metadata and are not needed by this worker.
      eventReceived: event !== undefined,
    };
  } catch (error) {
    // Throw so EventBridge/Lambda records a failed invocation and applies its
    // configured retry/DLQ policy. Do not stringify the event or credentials.
    throw error;
  }
}
