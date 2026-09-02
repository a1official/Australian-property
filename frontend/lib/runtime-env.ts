import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Reads repository .env only for local server-side development. */
export function runtimeEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const direct = env[name]?.trim();
  if (direct) return direct;
  if (env !== process.env || env.NODE_ENV === "production") return undefined;

  for (const path of [resolve(process.cwd(), ".env"), resolve(process.cwd(), "..", ".env")]) {
    if (!existsSync(/* turbopackIgnore: true */ path)) continue;
    try {
      const line = readFileSync(/* turbopackIgnore: true */ path, "utf8").split(/\r?\n/).find((candidate) => candidate.startsWith(`${name}=`));
      const value = line?.slice(name.length + 1).trim().replace(/^['"]|['"]$/g, "");
      if (value) return value;
    } catch {
      // Try the next local candidate.
    }
  }
  return undefined;
}
