import { z } from 'zod';

import { registerSecret } from './redact';

/**
 * The ONE place in the application that reads `process.env`.
 *
 * Everything else imports the typed `env` object from here. The only other
 * file permitted to touch `process.env` is `drizzle.config.ts`, which runs
 * outside the Next.js runtime — see NOTES.md §5.
 */

const nonEmpty = (label: string) =>
  z.string().min(1, `${label} must not be empty`);

/** A Postgres connection string. Neon hands these out already URL-encoded. */
const postgresUrl = (label: string) =>
  nonEmpty(label).refine(
    (v) => v.startsWith('postgres://') || v.startsWith('postgresql://'),
    { message: `${label} must be a postgres:// or postgresql:// connection string` },
  );

/**
 * An origin with no trailing slash. `AUTH_URL` in particular must match the
 * deployment origin exactly — a trailing slash breaks Auth.js callback URLs.
 */
const origin = (label: string) =>
  nonEmpty(label)
    .url(`${label} must be an absolute URL`)
    .refine((v) => !v.endsWith('/'), {
      message: `${label} must not have a trailing slash`,
    });

/**
 * Service-account private keys arrive with literal backslash-n sequences when
 * they pass through a `.env` file or a Vercel environment variable. Unescape
 * once, here, so no call site has to remember. Idempotent: a key that already
 * contains real newlines passes through unchanged.
 */
const pemPrivateKey = nonEmpty('GOOGLE_PRIVATE_KEY')
  .transform((v) => v.replace(/\\n/g, '\n'))
  .refine((v) => v.includes('-----BEGIN') && v.includes('PRIVATE KEY-----'), {
    message:
      'GOOGLE_PRIVATE_KEY does not look like a PEM block. Copy the `private_key` ' +
      'field from the service-account JSON verbatim, including the BEGIN/END lines.',
  });

/** Secrets we generate ourselves. Short ones are a real risk, so enforce length. */
const generatedSecret = (label: string, min = 24) =>
  nonEmpty(label).min(
    min,
    `${label} must be at least ${min} characters — generate one with \`openssl rand -hex 32\``,
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // ── Database (Neon) ────────────────────────────────────────────────────────
  DATABASE_URL: postgresUrl('DATABASE_URL'),
  DATABASE_URL_UNPOOLED: postgresUrl('DATABASE_URL_UNPOOLED'),

  // ── Google Search Console ──────────────────────────────────────────────────
  GOOGLE_SERVICE_ACCOUNT_EMAIL: nonEmpty('GOOGLE_SERVICE_ACCOUNT_EMAIL').email(
    'GOOGLE_SERVICE_ACCOUNT_EMAIL must be the `client_email` from the service-account JSON',
  ),
  GOOGLE_PRIVATE_KEY: pemPrivateKey,

  // ── DataForSEO ─────────────────────────────────────────────────────────────
  DATAFORSEO_LOGIN: nonEmpty('DATAFORSEO_LOGIN'),
  DATAFORSEO_PASSWORD: nonEmpty('DATAFORSEO_PASSWORD'),
  DATAFORSEO_PINGBACK_SECRET: generatedSecret('DATAFORSEO_PINGBACK_SECRET'),

  // ── Cron & app ─────────────────────────────────────────────────────────────
  CRON_SECRET: generatedSecret('CRON_SECRET'),
  APP_BASE_URL: origin('APP_BASE_URL'),

  // ── Auth.js ────────────────────────────────────────────────────────────────
  AUTH_SECRET: generatedSecret('AUTH_SECRET'),
  AUTH_URL: origin('AUTH_URL'),

  // ── Seed (optional) ────────────────────────────────────────────────────────
  SEED_ADMIN_EMAIL: blankAsUnset(z.string().email()),
  SEED_ADMIN_PASSWORD: blankAsUnset(z.string().min(8)),
  /** Optional: seeds a `client` account scoped to the seeded property only. */
  SEED_CLIENT_EMAIL: blankAsUnset(z.string().email()),
  SEED_CLIENT_PASSWORD: blankAsUnset(z.string().min(8)),
});

/**
 * An optional variable where an empty string means "not set".
 *
 * A `.env` file cannot express absence. `SEED_ADMIN_PASSWORD=` and a missing
 * line look identical to a human and completely different to Zod: dotenv loads
 * the first as `''`, which then fails `.min(8)` — so `.env.example`, whose
 * whole job is to be copied, shipped a file that could not start the app. The
 * documented first run (`cp .env.example .env.local && pnpm db:seed`) failed on
 * a variable the README calls optional.
 *
 * Deliberately NOT applied to required variables. A required value left blank
 * must still fail, loudly and by name — silently treating it as absent is how a
 * deployment comes up with no database URL and a confusing error three layers
 * down.
 */
function blankAsUnset<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
}

export type Env = z.infer<typeof envSchema>;
export type EnvKey = keyof Env;

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  • ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}

/**
 * Register every literal secret with the scrubber, so that if one leaks into a
 * driver error or a third-party exception it is replaced before that message
 * reaches a log line or an API response.
 */
function registerSecrets(parsed: Partial<Env>): void {
  for (const value of [
    parsed.DATABASE_URL,
    parsed.DATABASE_URL_UNPOOLED,
    parsed.GOOGLE_PRIVATE_KEY,
    parsed.DATAFORSEO_PASSWORD,
    parsed.DATAFORSEO_PINGBACK_SECRET,
    parsed.CRON_SECRET,
    parsed.AUTH_SECRET,
    parsed.SEED_ADMIN_PASSWORD,
  ]) {
    registerSecret(value);
  }
}

function shouldSkip(): boolean {
  const flag = process.env.SKIP_ENV_VALIDATION;
  return flag === '1' || flag === 'true';
}

let cached: Env | null = null;

function loadEnv(): Env {
  if (cached) return cached;

  // Build-time escape hatch: `next build` evaluates route modules, and in CI
  // the runtime secrets are usually injected only at deploy time.
  if (shouldSkip()) {
    cached = process.env as unknown as Env;
    return cached;
  }

  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    // Report the variable NAMES that failed and why — never the values. An
    // invalid secret is still a secret (acceptance criterion 12).
    throw new Error(
      `Invalid environment variables:\n${formatIssues(parsed.error)}\n\n` +
        'See .env.example and requirements.md for where each value comes from.',
    );
  }

  registerSecrets(parsed.data);
  cached = parsed.data;
  return cached;
}

/**
 * The typed environment.
 *
 * Validation is deferred to first property access rather than to module load,
 * for one concrete reason: the setup scripts in `scripts/` must be runnable
 * while the environment is still half-provisioned. Someone verifying their
 * Search Console credentials has not necessarily signed up for DataForSEO yet,
 * and failing their `pnpm verify:gsc` on an unrelated missing variable would
 * make the setup guide impossible to follow in order. Those scripts call
 * `requireEnv` for the narrow slice they need.
 *
 * For the application itself the behaviour is unchanged in practice: the first
 * access happens during module initialisation of whichever server module needs
 * it, so a bad environment still fails immediately and loudly.
 */
export const env: Env = new Proxy({} as Env, {
  get: (_target, prop) => loadEnv()[prop as EnvKey],
  has: (_target, prop) => prop in loadEnv(),
  ownKeys: () => Reflect.ownKeys(loadEnv()),
  getOwnPropertyDescriptor: (_target, prop) => {
    const descriptor = Object.getOwnPropertyDescriptor(loadEnv(), prop);
    return descriptor ? { ...descriptor, configurable: true } : undefined;
  },
});

/**
 * Validate and return only the named variables.
 *
 * For setup and verification scripts that must work before the whole
 * environment exists. Application code uses `env` instead — a route that
 * validates only what it happens to read today is a route that breaks
 * silently when someone adds a read tomorrow.
 */
export function requireEnv<K extends EnvKey>(...keys: K[]): Pick<Env, K> {
  const shape = Object.fromEntries(keys.map((k) => [k, envSchema.shape[k]]));
  const parsed = z.object(shape).safeParse(process.env);

  if (!parsed.success) {
    throw new Error(
      `Invalid environment variables:\n${formatIssues(parsed.error)}\n\n` +
        'See requirements.md for where each value comes from.',
    );
  }

  // z.object() over a dynamically built shape cannot carry the mapped type
  // through, so the cast restores what the `K` parameter already guarantees.
  const data = parsed.data as unknown as Pick<Env, K>;
  registerSecrets(data as Partial<Env>);
  return data;
}

/**
 * Pre-computed HTTP Basic credential for DataForSEO.
 * Derived here so the raw password never travels further into the codebase.
 */
export function dataForSeoAuthHeader(): string {
  const { DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD } = requireEnv(
    'DATAFORSEO_LOGIN',
    'DATAFORSEO_PASSWORD',
  );
  return `Basic ${Buffer.from(`${DATAFORSEO_LOGIN}:${DATAFORSEO_PASSWORD}`).toString('base64')}`;
}
