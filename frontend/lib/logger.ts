/**
 * Structured JSON logging with secret redaction.
 *
 * Every worker line is emitted as one JSON object so Render's log drain can be
 * queried by field. Values that look like credentials are redacted before they
 * can reach a log sink.
 */

const SECRET_KEY_PATTERN =
  /(password|passwd|secret|token|api_?key|authorization|cookie|credential|client_?secret|connection_?string|database_?url)/i;

const SECRET_VALUE_PATTERNS: Array<[RegExp, string]> = [
  // Query-string credentials, e.g. Browserless ?token=...
  [/([?&](?:token|api_?key|access_?token)=)[^&\s"']+/gi, "$1***"],
  // Basic/bearer headers and postgres URIs with inline credentials.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***"],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^:/\s@]+:[^@\s]+@/gi, "$1***:***@"],
];

export type LogLevel = "debug" | "info" | "warn" | "error";

export function redact(value: string): string {
  let output = value;
  for (const [pattern, replacement] of SECRET_VALUE_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

function redactUnknown(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redact(value);
  if (value === null || typeof value !== "object" || depth > 6) return value;
  if (value instanceof Error) return redact(value.message);
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      SECRET_KEY_PATTERN.test(key) ? "***" : redactUnknown(child, depth + 1),
    ]),
  );
}

export type Logger = {
  child(bindings: Record<string, unknown>): Logger;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
};

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(
  bindings: Record<string, unknown> = {},
  options: { minLevel?: LogLevel; sink?: (line: string) => void } = {},
): Logger {
  const minLevel = options.minLevel ?? (process.env.LOG_LEVEL as LogLevel | undefined) ?? "info";
  const sink = options.sink ?? ((line: string) => process.stdout.write(line + "\n"));

  function emit(level: LogLevel, message: string, fields?: Record<string, unknown>) {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    const payload = {
      ts: new Date().toISOString(),
      level,
      msg: redact(message),
      ...(redactUnknown({ ...bindings, ...(fields ?? {}) }) as Record<string, unknown>),
    };
    try {
      sink(JSON.stringify(payload));
    } catch {
      sink(JSON.stringify({ ts: payload.ts, level, msg: payload.msg, logSerializationFailed: true }));
    }
  }

  return {
    child: (extra) => createLogger({ ...bindings, ...extra }, { minLevel, sink }),
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}
