/**
 * Secret scrubbing for anything that might reach a log line or an API response.
 *
 * Acceptance criterion 12 — "no secret is logged, committed, or returned in any
 * API response" — is not satisfied by being careful at each call site. Driver
 * errors in particular routinely embed the full connection string, and those
 * strings contain the database password. So every error message that leaves a
 * catch block goes through here first.
 */

/**
 * Patterns for credentials that appear inside otherwise-useful strings.
 * Ordered most specific first, since replacements are applied in sequence.
 */
const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // postgres://user:password@host/db  →  postgres://user:***@host/db
  [/\b(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, '$1***@'],
  // Any other scheme carrying userinfo credentials.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^:\s/]+:)[^@\s]+@/gi, '$1***@'],
  // PEM private key blocks.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PEM]'],
  // Authorization headers, however they were serialised.
  [/\b(Authorization"?\s*[:=]\s*"?)(Basic|Bearer)\s+[A-Za-z0-9+/=._-]+/gi, '$1$2 ***'],
  // `secret=`, `token=`, `password=`, `key=` query params and JSON fields.
  [/\b((?:api[_-]?key|secret|token|password|passwd|pwd)"?\s*[:=]\s*"?)[^\s"&,}]+/gi, '$1***'],
];

/**
 * Values known at runtime that must never appear in output, even when they
 * show up somewhere none of the patterns above would catch. Registered by
 * `registerSecret` rather than imported from env, so this module stays free of
 * import cycles and usable from tests.
 */
const knownSecrets = new Set<string>();

/** Register a literal secret value for scrubbing. Short values are ignored. */
export function registerSecret(value: string | undefined | null): void {
  if (typeof value === 'string' && value.length >= 8) knownSecrets.add(value);
}

export function redact(input: string): string {
  let out = input;

  for (const secret of knownSecrets) {
    if (out.includes(secret)) out = out.split(secret).join('***');
  }

  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }

  return out;
}

/** Turn an unknown thrown value into a safe, single-line message. */
export function redactError(error: unknown): string {
  return redact(describe(error)).replace(/\s+/g, ' ').trim().slice(0, 2000);
}

/** Best-effort string form of an unknown throw. Always returns a string. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;

  try {
    // JSON.stringify returns undefined — not a string — for undefined,
    // functions and symbols, so fall back rather than propagating that.
    return JSON.stringify(error) ?? String(error);
  } catch {
    // Circular structures and throwing getters land here.
    return String(error);
  }
}
