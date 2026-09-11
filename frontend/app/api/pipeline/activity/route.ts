import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ActivityKind = "scheduled" | "manual" | "scan" | "registered" | "completed" | "error";

type Activity = {
  at: string;
  kind: ActivityKind;
  label: string;
};

/** Minutes of history requested. */
const WINDOW_MINUTES = 45;
/**
 * Raw log lines to pull. The dispatcher emits several lines per scan, so at a
 * two-minute cadence a small limit silently truncates the window to a few
 * minutes: the route would claim 45 minutes and return 10. This is generous
 * because most lines are discarded by the classifier below.
 */
const LOG_EVENT_LIMIT = 1_000;
/** Rows returned to the dashboard. */
const MAX_ACTIVITY_EVENTS = 14;

class ActivityConfigurationError extends Error {}

function awsConfig() {
  // Region falls back to the deployment region used everywhere else in this
  // project. Previously a missing AWS_REGION made this route fail exactly like
  // an IAM denial, which is misleading to diagnose.
  const region = process.env.AWS_REGION?.trim() || "ap-southeast-2";
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId || !secretAccessKey) {
    throw new ActivityConfigurationError("AWS credentials are not configured for this deployment.");
  }
  return { region, credentials: { accessKeyId, secretAccessKey } };
}

/**
 * Extracts the JSON object from a CloudWatch log line.
 *
 * Lambda prefixes anything written with console.* with a timestamp and request
 * id, tab separated:
 *
 *   2026-09-11T09:31:10.649Z\t32e39fbe-…\tINFO\t{"msg":"dispatch.started",…}
 *
 * Calling JSON.parse on the whole line therefore throws, which previously made
 * every console-logged event unclassifiable: dispatch.started and
 * dispatch.completed fell through to a generic label, so a scheduled scan could
 * not be told apart from a manual one. Lines written straight to stdout by the
 * structured logger have no prefix, and both shapes are handled here.
 */
function parseLogJson(message: string): Record<string, unknown> | null {
  const start = message.indexOf("{");
  if (start === -1) return null;
  try {
    const parsed = JSON.parse(message.slice(start)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Curated, non-sensitive scheduler activity for the public dashboard. Raw
 * CloudWatch messages stay in AWS because they may include mailbox metadata.
 */
function activityFromLog(timestamp: number, message: string): Activity | null {
  const at = new Date(timestamp).toISOString();
  const item = parseLogJson(message);
  if (!item) return null;

  if (item.msg === "dispatch.started") {
    // EventBridge sets source to "aws.events"; the Vercel button sends "vercel".
    // The trigger is what an operator wants to see, so it carries the outcome
    // reported by the scan line below and that line is dropped. One row per
    // scan keeps a two-minute cadence from filling the panel.
    const scheduled = item.source === "aws.events";
    return {
      at,
      kind: scheduled ? "scheduled" : "manual",
      label: scheduled ? "Scheduled inbox scan" : "Manual inbox scan",
    };
  }

  if (item.msg === "dispatch.completed") {
    const count = typeof item.discovered === "number" ? item.discovered : 0;
    // Only report a completion that found work. An idle completion every two
    // minutes would fill the panel and push real events out of view.
    return count
      ? { at, kind: "completed", label: `Scan completed: ${count} new CSV job${count === 1 ? "" : "s"}` }
      : null;
  }

  if (item.msg === "intake.registered") {
    return { at, kind: "registered", label: "New CSV registered and queued" };
  }

  if (item.msg === "gmail.messages.skipped_known") {
    // Only surfaced when the scan actually had new mail to download. An idle
    // "nothing new" line every two minutes would push real events off the panel;
    // the dispatch.started row already shows that the scan ran.
    const fetched = typeof item.fetched === "number" ? item.fetched : 0;
    return fetched
      ? { at, kind: "scan", label: `Inbox checked: ${fetched} new attachment${fetched === 1 ? "" : "s"} downloaded` }
      : null;
  }

  if (item.level === "error") {
    return { at, kind: "error", label: "Mailbox scan reported an error" };
  }

  return null;
}

export async function GET() {
  let config: ReturnType<typeof awsConfig>;
  try {
    config = awsConfig();
  } catch (error) {
    // Distinguished from a permission failure so the dashboard does not blame
    // IAM for a missing environment variable.
    return Response.json(
      {
        ok: false,
        reason: "not_configured",
        error: error instanceof Error ? error.message : "AWS log reading is not configured.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const client = new CloudWatchLogsClient(config);
    const result = await client.send(
      new FilterLogEventsCommand({
        logGroupName: process.env.AWS_DISPATCH_LOG_GROUP?.trim() || "/aws/lambda/parcel-atlas-dispatch",
        startTime: Date.now() - WINDOW_MINUTES * 60_000,
        limit: LOG_EVENT_LIMIT,
        interleaved: true,
      }),
    );

    const seen = new Set<string>();
    const events = (result.events ?? [])
      .flatMap((event) => {
        if (typeof event.timestamp !== "number" || !event.message) return [];
        const activity = activityFromLog(event.timestamp, event.message);
        if (!activity) return [];
        const key = `${activity.at}:${activity.label}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [activity];
      })
      .slice(-MAX_ACTIVITY_EVENTS)
      .reverse();

    return Response.json(
      { ok: true, windowMinutes: WINDOW_MINUTES, events },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const denied = (error as { name?: string }).name === "AccessDeniedException";
    return Response.json(
      {
        ok: false,
        reason: denied ? "access_denied" : "unavailable",
        error: denied
          ? "This deployment's AWS user cannot read the dispatch log group."
          : "Scheduler activity could not be read from CloudWatch.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
