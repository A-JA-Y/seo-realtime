import { sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { redactError } from '@/lib/redact';
import { db } from '@/server/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Every table the first migration is expected to create. */
const EXPECTED_TABLES = [
  'organizations',
  'users',
  'properties',
  'user_properties',
  'keywords',
  'keyword_targets',
  'gsc_snapshots',
  'serp_checks',
  'serp_payloads',
  'daily_rank_rollups',
  'alerts',
  'ingest_runs',
] as const;

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
        AND table_name = ANY(${sql.param(EXPECTED_TABLES as unknown as string[])}::text[])
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
