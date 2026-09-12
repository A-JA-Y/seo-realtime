import { getTableName, is, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { NextResponse } from 'next/server';

import { redactError } from '@/lib/redact';
import { db } from '@/server/db';
import * as schema from '@/server/db/schema';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Every table the application expects, DERIVED from the schema.
 *
 * This was a hand-written list and it drifted: two tables were added in later
 * milestones and the list was not, so the endpoint cheerfully reported
 * "migrated: true, 12 of 12" on a database missing both. A health check that
 * lies about the schema is worse than not having one — it is the thing you
 * trust at 2am to tell you the deploy landed.
 *
 * Deriving it means the list cannot fall behind: adding a table to `schema.ts`
 * adds it here, and `migrations.integration.test.ts` separately proves a
 * migration actually creates it.
 */
const EXPECTED_TABLES: string[] = Object.values(schema)
  .filter((value) => is(value, PgTable))
  .map((table) => getTableName(table as PgTable));

/**
 * Liveness + schema check.
 *
 * Reports presence and counts only. It never echoes a connection string, a
 * credential, or row content — acceptance criterion 12 applies to health
 * endpoints as much as to anything else.
 */
export async function GET() {
  const startedAt = Date.now();

  try {
    const result = await db.execute<{ table_name: string }>(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY(${sql.param(EXPECTED_TABLES)}::text[])
    `);

    const present = new Set(result.rows.map((r) => r.table_name));
    const missing = EXPECTED_TABLES.filter((t) => !present.has(t));
    const migrated = missing.length === 0;

    return NextResponse.json(
      {
        status: migrated ? 'ok' : 'degraded',
        database: 'reachable',
        migrated,
        tablesPresent: present.size,
        tablesExpected: EXPECTED_TABLES.length,
        ...(migrated ? {} : { missingTables: missing }),
        // Neon scale-to-zero makes the first request after idle slow. Surfacing
        // this makes a cold start legible instead of alarming.
        latencyMs: Date.now() - startedAt,
      },
      { status: migrated ? 200 : 503 },
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        job: 'health',
        message: 'database unreachable',
        error: redactError(error),
      }),
    );

    return NextResponse.json(
      {
        status: 'error',
        database: 'unreachable',
        code: 'DB_UNREACHABLE',
        latencyMs: Date.now() - startedAt,
      },
      { status: 503 },
    );
  }
}
