/**
 * Structured logger with mandatory secret redaction (Constitution Principle II). Any object
 * key that looks like it holds a secret is replaced with a redaction marker before output,
 * so credentials, cookies, tokens, and TOTP seeds can never leak into logs.
 */

const SECRET_KEY_PATTERN =
  /(pass(word|wd)?|secret|token|cookie|totp|answer|authorization|auth[-_]?token|api[-_]?key|ciphertext|data[-_]?key|credential|session)/i;

export const REDACTED = "[REDACTED]";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Deep-redact any secret-looking fields in a value. Safe against cycles. */
export function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, seen));
  if (Buffer.isBuffer(value)) return REDACTED;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redact(val, seen);
  }
  return out;
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  name?: string;
  /** Output sink; defaults to stdout. Injectable for tests. */
  sink?: (line: string) => void;
  /** Clock; injectable for deterministic tests. */
  now?: () => string;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const sink = opts.sink ?? ((line: string) => process.stdout.write(line + "\n"));
  const now = opts.now ?? (() => new Date().toISOString());
  const emit = (level: LogLevel, msg: string, meta?: Record<string, unknown>) => {
    const record: Record<string, unknown> = { time: now(), level, msg };
    if (opts.name) record.name = opts.name;
    if (meta) record.meta = redact(meta);
    sink(JSON.stringify(record));
  };
  return {
    debug: (m, meta) => emit("debug", m, meta),
    info: (m, meta) => emit("info", m, meta),
    warn: (m, meta) => emit("warn", m, meta),
    error: (m, meta) => emit("error", m, meta),
  };
}
