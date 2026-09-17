/**
 * Vercel build command (see `buildCommand` in vercel.json).
 *
 * Vercel does not run database migrations; `next build` alone would deploy
 * code that expects tables the database does not have, and the first request
 * would 500 on a missing relation. So: migrate first, then build. Migrations
 * are additive and idempotent (drizzle records what it has applied), which is
 * what makes running them at build time safe.
 *
 * One of exactly three files permitted to read `process.env` directly — it
 * runs before the application, and therefore before `src/lib/env.ts`, exists.
 * See `src/lib/env-boundary.test.ts`.
 */
import { spawnSync } from 'node:child_process';

/**
 * drizzle-kit prints NOTHING when a migration fails.
 *
 * It renders the migration inside a hanji TaskView whose `render('rejected')`
 * ignores the error it is handed and re-prints the spinner line, so the real
 * cause is discarded before drizzle-kit's own `console.error` can reach it.
 * Verified against a refused connection, a bad hostname and wrong credentials:
 * exit 1, and not one word about why — under a TTY as well, so this is not a
 * CI artifact and Vercel cannot do better. Hence this pointer, which is the
 * only thing standing between a failed deploy and an empty build log.
 */
const MIGRATE_HINT = `
  drizzle-kit exits 1 without printing anything when a migration fails, for any
  reason, so the silence above carries no information. The two likely causes:

    1. The database is unreachable. DATABASE_URL_UNPOOLED must be the DIRECT
       Neon string — no "-pooler" in the hostname — with ?sslmode=require, on a
       project that is not suspended.
    2. A statement in drizzle/*.sql failed. Most often the database already has
       the schema but an empty __drizzle_migrations journal, so the first
       migration re-runs CREATE TYPE / CREATE TABLE on objects that exist.

  To tell them apart, connect with DATABASE_URL_UNPOOLED and look for the
  __drizzle_migrations table and what is in it.`;

/** What a project with no environment variables configured looks like. */
const NO_ENV_HINT = `
  This Vercel project has no DATABASE_URL_UNPOOLED, which almost always means
  no environment variables were added to it at all. The build would compile and
  then fail ~50s from now in "Collecting page data", because every route
  reaches the database handle and that validates the whole environment.

  Fix it once, properly: Vercel → the project → Settings → Environment
  Variables. Add every variable from .env.example EXCEPT APP_BASE_URL, AUTH_URL
  and SKIP_ENV_VALIDATION, tick Production (and Preview, or preview builds fail
  the same way), then Redeploy. APP_BASE_URL and AUTH_URL are deliberately left
  out: they default to this deployment's own URL.

  To build without a database anyway — a preview with no backing store — set
  SKIP_ENV_VALIDATION=1 and this step becomes a warning.`;

function run(label, cmd, args, hint) {
  console.log(`\n▶ ${label}: ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, { stdio: 'inherit', env: process.env });
  if (result.status !== 0) {
    console.error(`\n✖ ${label} failed with exit code ${result.status}`);
    if (hint) console.error(hint);
    process.exit(result.status ?? 1);
  }
}

const skipValidation =
  process.env.SKIP_ENV_VALIDATION === '1' || process.env.SKIP_ENV_VALIDATION === 'true';

if (process.env.DATABASE_URL_UNPOOLED) {
  run('migrate', 'pnpm', ['db:migrate'], MIGRATE_HINT);
} else if (skipValidation) {
  console.warn(
    '\n! DATABASE_URL_UNPOOLED is not set — skipping migrations, because ' +
      'SKIP_ENV_VALIDATION is on. The deployment will build, but every page that ' +
      'touches the database will fail until the variable is set and it is redeployed.',
  );
} else {
  /*
   * Fail HERE rather than 50 seconds later inside a Next.js stack trace.
   *
   * This branch used to warn and carry on, on the theory that a preview
   * without a database should still build. It cannot: the same missing
   * configuration fails `next build` at page-data collection, just later and
   * as a wall of Zod issues under "Failed to collect page data for
   * /api/auth/[...nextauth]" — which reads like a bug in the app rather than
   * an unconfigured project. SKIP_ENV_VALIDATION is the real escape hatch, and
   * it is checked above.
   */
  console.error('\n✖ Refusing to build: the environment is not configured.');
  console.error(NO_ENV_HINT);
  process.exit(1);
}

run('build', 'pnpm', ['build']);
