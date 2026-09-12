import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleNeon, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';

import { env } from '@/lib/env';
import * as schema from './schema';

/**
 * Runtime database handle.
 *
 * Production path: Neon's HTTP driver against the POOLED connection string.
 * Serverless functions open many short-lived connections, and the pooler is
 * what stops us exhausting Postgres connection slots. Migrations use the
 * unpooled string instead — see drizzle.config.ts.
 *
 * The HTTP driver has no interactive transactions. Every write in this
 * codebase is therefore a single idempotent statement with
 * `ON CONFLICT DO UPDATE` on the table's natural key (domain rule 9) — which
 * is what we want regardless, because crons retry and schedulers double-fire.
 *
 * Local/CI path: any non-Neon host falls back to node-postgres, so the seed
 * script and the integration suite can run against a throwaway Postgres
 * without a Neon account. The branch is chosen from the connection string and
 * never fires in production, where the host is always *.neon.tech. See
 * NOTES.md §7.
 */
function isNeonHost(connectionString: string): boolean {
  try {
    return new URL(connectionString).hostname.endsWith('.neon.tech');
  } catch {
    return false;
  }
}

export type Database = NeonHttpDatabase<typeof schema>;

function createDb(): Database {
  const options = { schema, casing: 'snake_case' } as const;

  if (isNeonHost(env.DATABASE_URL)) {
    return drizzleNeon(neon(env.DATABASE_URL), options);
  }

  /*
   * node-postgres is structurally compatible with every query-builder method
   * this codebase uses, so it is surfaced under the production type rather
   * than as a union — a union of the two would collapse the `.returning()`
   * overloads and break typing at every call site. Declaring the Neon type is
   * also the conservative choice: it advertises no interactive transactions,
   * which is the constraint production actually runs under.
   */
  return drizzlePg(env.DATABASE_URL, options) as unknown as Database;
}

export const db = createDb();
export { schema };
