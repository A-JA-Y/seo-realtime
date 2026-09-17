/**
 * Vercel build command (see `buildCommand` in vercel.json).
 *
 * Vercel does not run database migrations; `next build` alone would deploy
 * code that expects tables the database does not have, and the first request
 * would 500 on a missing relation. So: migrate first, then build. Migrations
 * are additive and idempotent (drizzle records what it has applied), which is
 * what makes running them at build time safe.
 *
 * If DATABASE_URL_UNPOOLED is not set the migration step is skipped LOUDLY and
 * the build still runs, so a preview deployment without a database can exist
 * — but the log says exactly why the schema will be missing.
 */
import { spawnSync } from 'node:child_process';

function run(label, cmd, args) {
  console.log(`\n▶ ${label}: ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, { stdio: 'inherit', env: process.env });
  if (result.status !== 0) {
    console.error(`\n✖ ${label} failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

if (process.env.DATABASE_URL_UNPOOLED) {
  run('migrate', 'pnpm', ['db:migrate']);
} else {
  console.warn(
    '\n! DATABASE_URL_UNPOOLED is not set — skipping migrations. ' +
      'The deployment will build, but every page that touches the database will fail ' +
      'until the variable is set and the project is redeployed.',
  );
}

run('build', 'pnpm', ['build']);
