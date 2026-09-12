import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

loadDotenv({ path: ['.env.local', '.env'], quiet: true });

/**
 * drizzle-kit runs outside the Next.js runtime, so it is the one place that
 * legitimately touches process.env directly: src/lib/env.ts imports Next-only
 * assumptions and would pull the whole app graph into the CLI.
 *
 * Migrations use the UNPOOLED connection — the PgBouncer transaction-mode
 * pooler does not support the session-level advisory locks drizzle-kit takes.
 */
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL_UNPOOLED (or DATABASE_URL) must be set to run drizzle-kit');
}

export default defineConfig({
  schema: './src/server/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
