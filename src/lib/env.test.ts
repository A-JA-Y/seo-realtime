import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `src/lib/env.ts` parses at module load, so each case resets the module
 * registry and re-imports it with a fresh `process.env`.
 */
const VALID: Record<string, string> = {
  DATABASE_URL: 'postgresql://u:p@ep-a-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require',
  DATABASE_URL_UNPOOLED: 'postgresql://u:p@ep-a.ap-southeast-1.aws.neon.tech/neondb?sslmode=require',
  GOOGLE_SERVICE_ACCOUNT_EMAIL: 'rank-tracker-gsc@proj.iam.gserviceaccount.com',
  GOOGLE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBg\\n-----END PRIVATE KEY-----\\n',
  DATAFORSEO_LOGIN: 'me@example.com',
  DATAFORSEO_PASSWORD: 'dashboard-api-password',
  DATAFORSEO_PINGBACK_SECRET: 'f'.repeat(64),
  CRON_SECRET: 'a'.repeat(64),
  APP_BASE_URL: 'https://rank.example.com',
  AUTH_SECRET: 'b'.repeat(44),
  AUTH_URL: 'https://rank.example.com',
};

let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = { ...process.env };
  vi.resetModules();
});

afterEach(() => {
  process.env = saved;
});

function setEnv(overrides: Record<string, string | undefined> = {}) {
  for (const key of Object.keys(VALID)) delete process.env[key];
  delete process.env.SKIP_ENV_VALIDATION;
  Object.assign(process.env, VALID, overrides);
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
  }
}

describe('env', () => {
  it('accepts a complete, valid environment', async () => {
    setEnv();
    const { env } = await import('./env');
    expect(env.APP_BASE_URL).toBe('https://rank.example.com');
  });

  it('unescapes \\n in the service-account private key exactly once', async () => {
    setEnv();
    const { env } = await import('./env');
    expect(env.GOOGLE_PRIVATE_KEY).toContain('\n');
    expect(env.GOOGLE_PRIVATE_KEY).not.toContain('\\n');
    expect(env.GOOGLE_PRIVATE_KEY.split('\n')).toHaveLength(4);
  });

  it('passes an already-unescaped key through unchanged (idempotent)', async () => {
    const real = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----\n';
    setEnv({ GOOGLE_PRIVATE_KEY: real });
    const { env } = await import('./env');
    expect(env.GOOGLE_PRIVATE_KEY).toBe(real);
  });

  it('rejects a private key that is not a PEM block', async () => {
    setEnv({ GOOGLE_PRIVATE_KEY: 'the-whole-service-account.json' });
    const { env } = await import('./env');
    expect(() => env.GOOGLE_PRIVATE_KEY).toThrow(/GOOGLE_PRIVATE_KEY.*PEM block/s);
  });

  it('rejects AUTH_URL with a trailing slash', async () => {
    // A trailing slash here silently breaks every Auth.js callback URL.
    setEnv({ AUTH_URL: 'https://rank.example.com/' });
    const { env } = await import('./env');
    expect(() => env.AUTH_URL).toThrow(/AUTH_URL.*trailing slash/s);
  });

  it('rejects a database URL that is not a postgres connection string', async () => {
    setEnv({ DATABASE_URL: 'mysql://u:p@host/db' });
    const { env } = await import('./env');
    expect(() => env.DATABASE_URL).toThrow(/DATABASE_URL.*postgres/s);
  });

  it('rejects a short generated secret', async () => {
    setEnv({ CRON_SECRET: 'short' });
    const { env } = await import('./env');
    expect(() => env.CRON_SECRET).toThrow(/CRON_SECRET.*at least 24/s);
  });

  it('reports every missing variable at once, by name', async () => {
    setEnv({ DATABASE_URL: undefined, AUTH_SECRET: undefined });
    const { env } = await import('./env');
    expect(() => env.APP_BASE_URL).toThrow(/DATABASE_URL[\s\S]*AUTH_SECRET/);
  });

  it('never puts a secret VALUE into the error message', async () => {
    // Acceptance criterion 12 — an invalid secret is still a secret.
    setEnv({ CRON_SECRET: 'super-secret-but-too-short', AUTH_SECRET: 'another-live-secret' });
    const { env } = await import('./env');

    let message = '';
    try {
      void env.APP_BASE_URL;
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('AUTH_SECRET');
    expect(message).not.toContain('another-live-secret');
    expect(message).not.toContain('super-secret-but-too-short');
  });

  it('caches after a successful parse', async () => {
    setEnv();
    const { env } = await import('./env');
    expect(env.CRON_SECRET).toBe('a'.repeat(64));

    // Mutating process.env afterwards must not change the resolved values —
    // otherwise behaviour would drift mid-process.
    process.env.CRON_SECRET = 'c'.repeat(64);
    expect(env.CRON_SECRET).toBe('a'.repeat(64));
  });

  it('SKIP_ENV_VALIDATION=1 bypasses parsing for build-time evaluation', async () => {
    setEnv({ DATABASE_URL: undefined });
    process.env.SKIP_ENV_VALIDATION = '1';
    const { env } = await import('./env');
    expect(env.AUTH_URL).toBe('https://rank.example.com');
  });
});

describe('origin defaults on Vercel', () => {
  const PROD_HOST = 'rank-tracker-abc123.vercel.app';

  afterEach(() => {
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  });

  it('fills both origins from the production URL when they are unset', async () => {
    // The chicken-and-egg this exists for: on a first deploy the origin does
    // not exist yet, so neither variable can be filled in beforehand.
    setEnv({ APP_BASE_URL: undefined, AUTH_URL: undefined });
    process.env.VERCEL_PROJECT_PRODUCTION_URL = PROD_HOST;

    const { env } = await import('./env');
    expect(env.APP_BASE_URL).toBe(`https://${PROD_HOST}`);
    expect(env.AUTH_URL).toBe(`https://${PROD_HOST}`);
  });

  it('overrides a LOCALHOST value, which a pasted .env brings with it', async () => {
    /*
     * `.env.example` ships both as http://localhost:3000 and the deploy step is
     * "paste your .env into Vercel's form". A loopback origin is a well-formed
     * URL, so it passed validation and the build went green — then sign-in set
     * the cookie and redirected the browser to a port nothing is listening on,
     * and every queued SERP task asked DataForSEO to call back to localhost.
     */
    setEnv({ APP_BASE_URL: 'http://localhost:3000', AUTH_URL: 'http://localhost:3000' });
    process.env.VERCEL_PROJECT_PRODUCTION_URL = PROD_HOST;

    const { env } = await import('./env');
    expect(env.APP_BASE_URL).toBe(`https://${PROD_HOST}`);
    expect(env.AUTH_URL).toBe(`https://${PROD_HOST}`);
  });

  it.each(['http://127.0.0.1:3000', 'http://localhost', 'https://localhost:3000'])(
    'treats %s as loopback too',
    async (value) => {
      setEnv({ APP_BASE_URL: value });
      process.env.VERCEL_PROJECT_PRODUCTION_URL = PROD_HOST;

      const { env } = await import('./env');
      expect(env.APP_BASE_URL).toBe(`https://${PROD_HOST}`);
    },
  );

  it('REMOVES a loopback AUTH_URL from process.env, not just from the parsed value', async () => {
    /*
     * Auth.js reads process.env.AUTH_URL itself — `createActionURL` treats it
     * as the request origin, and `trustHost` does not override it (trustHost is
     * consulted only when AUTH_URL is absent). Correcting the parsed value is
     * therefore not enough: the stale entry has to leave the environment.
     */
    setEnv({ AUTH_URL: 'http://localhost:3000' });
    process.env.VERCEL_PROJECT_PRODUCTION_URL = PROD_HOST;

    const { env } = await import('./env');
    expect(env.AUTH_URL).toBe(`https://${PROD_HOST}`);
    expect(process.env.AUTH_URL).toBeUndefined();
  });

  it('never overrides a real origin — a custom domain is just a set variable', async () => {
    setEnv({ APP_BASE_URL: 'https://ranks.acme.com', AUTH_URL: 'https://ranks.acme.com' });
    process.env.VERCEL_PROJECT_PRODUCTION_URL = PROD_HOST;

    const { env } = await import('./env');
    expect(env.APP_BASE_URL).toBe('https://ranks.acme.com');
    expect(env.AUTH_URL).toBe('https://ranks.acme.com');
  });

  it('leaves localhost alone OFF Vercel, so local development still works', async () => {
    setEnv({ APP_BASE_URL: 'http://localhost:3000', AUTH_URL: 'http://localhost:3000' });
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;

    const { env } = await import('./env');
    expect(env.APP_BASE_URL).toBe('http://localhost:3000');
    expect(process.env.AUTH_URL).toBe('http://localhost:3000');
  });
});

describe('requireEnv', () => {
  it('validates only the named slice, ignoring everything else', async () => {
    // The setup story this exists for: someone verifying Search Console before
    // they have signed up for DataForSEO at all.
    setEnv({
      DATAFORSEO_LOGIN: undefined,
      DATAFORSEO_PASSWORD: undefined,
      DATAFORSEO_PINGBACK_SECRET: undefined,
    });

    const { requireEnv } = await import('./env');
    const slice = requireEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY');

    expect(slice.GOOGLE_SERVICE_ACCOUNT_EMAIL).toBe(VALID.GOOGLE_SERVICE_ACCOUNT_EMAIL);
    expect(slice.GOOGLE_PRIVATE_KEY).toContain('\n');
  });

  it('still fails when a variable inside the slice is bad', async () => {
    setEnv({ GOOGLE_SERVICE_ACCOUNT_EMAIL: 'not-an-email' });
    const { requireEnv } = await import('./env');
    expect(() => requireEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL')).toThrow(
      /GOOGLE_SERVICE_ACCOUNT_EMAIL/,
    );
  });
});
