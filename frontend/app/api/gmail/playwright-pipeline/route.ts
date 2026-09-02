import { spawn } from "node:child_process";
import { resolve } from "node:path";

export const runtime = "nodejs";

type PipelineState = {
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  pid?: number;
  log: string[];
};

const stateKey = "__parcelAtlasPlaywrightPipelineState";

function state(): PipelineState {
  const scope = globalThis as typeof globalThis & { [stateKey]?: PipelineState };
  return (scope[stateKey] ??= { running: false, log: [] });
}

function publicState(current: PipelineState) {
  return { ...current, log: current.log.slice(-40), lastLog: current.log.at(-1) || "Waiting to start…" };
}

export async function GET() {
  const current = state();
  if (current.running && !current.pid) {
    current.running = false;
    current.exitCode = 1;
    current.finishedAt = new Date().toISOString();
    current.log.push("Pipeline launcher exited before a child process was created.");
  }
  return Response.json(publicState(current), { headers: { "Cache-Control": "no-store" } });
}

export async function POST() {
  // The saved Gmail browser session lives only on the local workstation.
  // Never expose an endpoint that can start this local automation in production.
  if (process.env.NODE_ENV === "production") {
    return Response.json({ detail: "The Browserless pipeline can only run from the local workstation." }, { status: 403 });
  }

  const current = state();
  if (current.running && current.pid) return Response.json(publicState(current), { status: 202 });
  if (current.running) {
    current.running = false;
    current.exitCode = 1;
    current.finishedAt = new Date().toISOString();
    current.log.push("Discarded an orphaned startup state from the previous launcher.");
  }

  current.running = true;
  current.startedAt = new Date().toISOString();
  current.finishedAt = undefined;
  current.exitCode = undefined;
  current.pid = undefined;
  current.log = ["Starting the local Browserless Gmail pipeline…"];

  // Invoke the installed TypeScript runner directly. `pnpm.cmd` can resolve
  // differently when launched by Next's Windows dev process, leaving a UI job
  // permanently marked as running without a child pipeline.
  const child = spawn(process.execPath, [
    resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
    "scripts/gmail-pipeline.ts",
    "--base-url",
    "http://localhost:3004",
    "--max-emails",
    "1",
  ], {
    cwd: resolve(process.cwd()),
    env: process.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const append = (chunk: Buffer) => {
    for (const line of chunk.toString().split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
      current.log.push(line);
    }
    current.log = current.log.slice(-200);
  };
  current.pid = child.pid;
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("error", (error) => {
    current.log.push(`Unable to start pipeline: ${error.message}`);
    current.running = false;
    current.exitCode = 1;
    current.pid = undefined;
    current.finishedAt = new Date().toISOString();
  });
  child.on("close", (exitCode) => {
    current.running = false;
    current.exitCode = exitCode;
    current.pid = undefined;
    current.finishedAt = new Date().toISOString();
    current.log.push(exitCode === 0 ? "Pipeline completed." : `Pipeline stopped with exit code ${exitCode ?? "unknown"}.`);
  });

  return Response.json(publicState(current), { status: 202 });
}
