/**
 * Vitest bootstrap.
 *
 * Unit tests must never reach a network or a database, so we install a set of
 * syntactically valid but obviously fake credentials before any module reads
 * `src/lib/env.ts`. Integration tests that DO want a real Neon dev branch
 * provide their own values via `.env.test.local`, which is loaded first and
 * wins because we only fill in what is missing.
 */
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: ['.env.test.local', '.env.test'], quiet: true });

/*
 * Integration tests run against a real Postgres — a Neon `dev` branch in CI,
 * or any throwaway instance locally. Point TEST_DATABASE_URL at it and the
 * application's own `db` handle follows, so the suite exercises the real
 * query builder rather than a stand-in.
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.DATABASE_URL_UNPOOLED = process.env.TEST_DATABASE_URL;
}

const fallbacks: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test?sslmode=disable',
  DATABASE_URL_UNPOOLED: 'postgresql://test:test@localhost:5432/test?sslmode=disable',
  GOOGLE_SERVICE_ACCOUNT_EMAIL: 'test-sa@test-project.iam.gserviceaccount.com',
  GOOGLE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nTEST\\n-----END PRIVATE KEY-----\\n',
  DATAFORSEO_LOGIN: 'test@example.com',
  DATAFORSEO_PASSWORD: 'test-password',
  DATAFORSEO_PINGBACK_SECRET: 'test-pingback-secret-0000000000000000',
  CRON_SECRET: 'test-cron-secret-000000000000000000000',
  APP_BASE_URL: 'http://localhost:3000',
  AUTH_SECRET: 'test-auth-secret-00000000000000000000000',
  AUTH_URL: 'http://localhost:3000',
};

for (const [key, value] of Object.entries(fallbacks)) {
  if (!process.env[key]) process.env[key] = value;
}
