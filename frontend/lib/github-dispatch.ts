/**
 * GitHub workflow-dispatch helper.
 *
 * Kept free of `server-only` and Next imports so it can be unit tested with
 * plain Node. The route handler is a thin wrapper around `dispatchWorkflow`.
 *
 * This module only asks GitHub to start a workflow. It never runs Playwright,
 * reads Gmail, or calls Cotality; the GitHub runner owns that work.
 */

const GITHUB_API_VERSION = "2022-11-28";
const DEFAULT_OWNER = "a1official";
const DEFAULT_REPO = "Australian-property";
const DEFAULT_WORKFLOW = "gmail-report-pipeline.yml";
const DEFAULT_REF = "main";
const MAX_REASON_LENGTH = 200;

export type DispatchConfig = {
  token: string;
  owner: string;
  repo: string;
  workflow: string;
  ref: string;
};

export class DispatchConfigError extends Error {
  readonly status = 503;
  constructor(message: string) {
    super(message);
    this.name = "DispatchConfigError";
  }
}

export class DispatchFailedError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "DispatchFailedError";
    this.status = status;
  }
}

/**
 * Reads dispatch configuration from the environment. The token is required and
 * has no default; the repository coordinates fall back to this project's.
 */
export function readDispatchConfig(env: NodeJS.ProcessEnv = process.env): DispatchConfig {
  const token = env.GITHUB_WORKFLOW_DISPATCH_TOKEN?.trim();
  if (!token) {
    // Fail closed with an actionable message. Never hint at the token value.
    throw new DispatchConfigError(
      "Mailbox runs are not configured on this deployment. Set GITHUB_WORKFLOW_DISPATCH_TOKEN in the Vercel project environment.",
    );
  }
  return {
    token,
    owner: env.GITHUB_REPOSITORY_OWNER?.trim() || DEFAULT_OWNER,
    repo: env.GITHUB_REPOSITORY_NAME?.trim() || DEFAULT_REPO,
    workflow: env.GITHUB_GMAIL_WORKFLOW_FILE?.trim() || DEFAULT_WORKFLOW,
    ref: env.GITHUB_WORKFLOW_REF?.trim() || DEFAULT_REF,
  };
}

export function workflowDispatchUrl(config: Pick<DispatchConfig, "owner" | "repo" | "workflow">): string {
  return `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/actions/workflows/${encodeURIComponent(config.workflow)}/dispatches`;
}

/** Keeps an operator note single-line and bounded before it reaches GitHub. */
export function sanitizeReason(reason: unknown): string {
  const text = typeof reason === "string" ? reason : "";
  const cleaned = text.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return (cleaned || "Manual UI Auto-pilot request").slice(0, MAX_REASON_LENGTH);
}

/**
 * Maps an upstream failure to a safe, actionable message.
 *
 * GitHub error bodies can echo request content, so the body is never forwarded
 * to the browser; only the status is used to explain what to fix.
 */
export function describeDispatchFailure(status: number): string {
  switch (status) {
    case 401:
      return "GitHub rejected the dispatch credentials. The workflow token is missing, expired, or revoked.";
    case 403:
      return "The GitHub token is not permitted to dispatch this workflow. Grant it Actions write access for this repository.";
    case 404:
      return "GitHub could not find the workflow or repository. Check the repository name and workflow file name.";
    case 422:
      return "GitHub rejected the dispatch request. Confirm the workflow supports workflow_dispatch on the target branch.";
    default:
      return status >= 500
        ? "GitHub is temporarily unavailable. Try starting the mailbox run again shortly."
        : `GitHub declined the dispatch request (HTTP ${status}).`;
  }
}

export type DispatchResult = {
  ok: true;
  owner: string;
  repo: string;
  workflow: string;
  ref: string;
  reason: string;
};

/**
 * Requests a workflow run. GitHub answers 204 No Content on success, which has
 * no body: calling response.json() on it would throw.
 */
export async function dispatchWorkflow(options: {
  reason?: unknown;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<DispatchResult> {
  const config = readDispatchConfig(options.env ?? process.env);
  const fetchImpl = options.fetchImpl ?? fetch;
  const reason = sanitizeReason(options.reason);

  let response: Response;
  try {
    response = await fetchImpl(workflowDispatchUrl(config), {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
        "User-Agent": "parcel-atlas-dispatch",
      },
      body: JSON.stringify({ ref: config.ref, inputs: { reason } }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
  } catch (error) {
    // Network-level failure. The message is ours, so it cannot leak the token.
    throw new DispatchFailedError(
      error instanceof Error && error.name === "TimeoutError"
        ? "GitHub did not respond in time. The mailbox run was not started."
        : "GitHub could not be reached. The mailbox run was not started.",
      502,
    );
  }

  if (response.status !== 204) {
    throw new DispatchFailedError(describeDispatchFailure(response.status), response.status >= 500 ? 502 : 502);
  }

  return { ok: true, owner: config.owner, repo: config.repo, workflow: config.workflow, ref: config.ref, reason };
}
