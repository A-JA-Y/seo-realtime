import { requireEnv } from './env';
import { redact, redactError } from './redact';

/**
 * Structured JSON logging.
 *
 * §12 requires `run_id`, `property_id`, `job`, `duration_ms` and `rows_written`
 * on ingest log lines. One JSON object per line, so Vercel's log drain can
 * filter on those fields instead of on substrings of prose.
 *
 * Every string that goes out is scrubbed. The most likely thing to end up in a
 * log line is a driver error, and driver errors carry connection strings.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Fields §12 names explicitly, in snake_case so log queries match the spec. */
export interface LogContext {
  job?: string;
  run_id?: string;
  property_id?: string;
  keyword_id?: string;
  duration_ms?: number;
  rows_written?: number;
  [key: string]: unknown;
}

/**
 * Field names whose VALUE is a credential regardless of what it looks like.
 *
 * Pattern matching alone is not enough here. `redact()` catches
 * `Authorization: Basic dXNlcj...` in free text because the key sits next to
 * the value, but once that pair becomes `{Authorization: "Basic dXNlcj..."}`
 * the key is JSON structure and the value is just a short opaque string —
 * indistinguishable, by pattern, from prose. Tightening the pattern enough to
 * catch it would start redacting the word "Basic" in sentences.
 *
 * Keying off the field name has no such ambiguity, and it is how the secret got
 * labelled in the first place.
 */
const SENSITIVE_KEY = /^(authorization|auth|secret|token|password|passwd|pwd|api[-_]?key|apikey|credential|private[-_]?key|cookie|set-cookie|session)$/i;

/**
 * Scrub recursively. A secret is just as leaked at `meta.request.headers.auth`
 * as at the top level, and callers pass nested objects constantly.
 */
function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth limit]';
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return redactError(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => scrub(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? '***' : scrub(inner, depth + 1);
  }
  return out;
}

export interface Logger {
  debug(message: string, fields?: LogContext): void;
  info(message: string, fields?: LogContext): void;
  warn(message: string, fields?: LogContext): void;
  error(message: string, fields?: LogContext): void;
  /** A logger carrying additional context on every line. */
  child(context: LogContext): Logger;
}

export interface LoggerOptions {
  minLevel?: LogLevel;
  /** Injected for tests. Defaults to console. */
  sink?: (level: LogLevel, line: string) => void;
}

const defaultSink = (level: LogLevel, line: string) => {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

export function createLogger(context: LogContext = {}, options: LoggerOptions = {}): Logger {
  const { minLevel = 'info', sink = defaultSink } = options;

  function emit(level: LogLevel, message: string, fields: LogContext = {}) {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

    const payload = scrub({ level, message, ...context, ...fields }) as Record<string, unknown>;

    let line: string;
    try {
      line = JSON.stringify(payload);
    } catch {
      // A circular structure in a log field must not take down the job it was
      // describing.
      line = JSON.stringify({ level, message: redact(message), log_error: 'unserializable fields' });
    }

    sink(level, line);
  }

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (extra) => createLogger({ ...context, ...extra }, options),
  };
}

/**
 * Process-wide default. Jobs create children carrying run_id / property_id.
 *
 * NODE_ENV comes through `requireEnv` rather than `process.env` so this module
 * does not become a second reader. It is the one variable with a schema default,
 * so validating it in isolation can never fail — which keeps `logger` importable
 * from the setup scripts that run before the environment is fully provisioned.
 */
const { NODE_ENV } = requireEnv('NODE_ENV');

export const logger: Logger = createLogger({}, { minLevel: NODE_ENV === 'test' ? 'error' : 'info' });
