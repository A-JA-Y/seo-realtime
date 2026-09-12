import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { getTableName, is, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { db } from '@/server/db';
import * as schema from './schema';

const DIR = join(process.cwd(), 'drizzle');
const hasDb = Boolean(process.env.TEST_DATABASE_URL);

interface Journal {
  entries: Array<{ idx: number; tag: string }>;
}

function journal(): Journal {
  return JSON.parse(readFileSync(join(DIR, 'meta/_journal.json'), 'utf8')) as Journal;
}

/** SQL with comments and blank lines stripped — what the file actually DOES. */
function statementsIn(tag: string): string {
  return readFileSync(join(DIR, `${tag}.sql`), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .replace(/--> statement-breakpoint/g, '')
    .trim();
}

describe('migrations', () => {
  /*
   * The guard that would have caught a real one.
   *
   * A header comment was prepended to a generated migration with
   * `open(p,'w').write(header + open(p).read())` — which truncates before it
   * reads. The file kept its comment and lost its CREATE TABLE. `drizzle-kit
   * migrate` then ran it happily, recorded it as applied, and the table simply
   * did not exist; the next developer's `generate` would have produced it
   * again. A migration that is recorded as applied and did nothing is worse
   * than one that failed.
   */
  it('every migration in the journal contains actual SQL, not only comments', () => {
    const empty = journal()
      .entries.filter((entry) => statementsIn(entry.tag).length === 0)
      .map((entry) => entry.tag);

    expect(empty, 'These migrations are comment-only and would silently no-op').toEqual([]);
  });

  it('every .sql file on disk is in the journal, and vice versa', () => {
    const onDisk = readdirSync(DIR)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => name.replace(/\.sql$/, ''))
      .sort();

    const inJournal = journal()
      .entries.map((entry) => entry.tag)
      .sort();

    // A file not in the journal never runs. A journal entry with no file
    // crashes the migrator on a fresh database — and only there, so it passes
    // every local run and fails the deploy.
    expect(onDisk).toEqual(inJournal);
  });

  it('journal indices are contiguous and in order', () => {
    const indices = journal().entries.map((entry) => entry.idx);
    expect(indices).toEqual(indices.map((_, i) => i));
  });

  describe.skipIf(!hasDb)('against a real database', () => {
    /*
     * The schema file is what the application queries through; the migrations
     * are what actually shape the database. Nothing keeps them honest except
     * this: every table drizzle declares must exist after the migrations run.
     *
     * The failure this catches is the expensive kind — code that typechecks,
     * tests that pass against a database someone migrated by hand, and a
     * production deploy that 500s on a missing relation.
     */
    it('declares no table the migrations do not create', async () => {
      // `is(value, PgTable)` rather than a duck-type check: the schema module
      // also exports enums, relations and helpers, and a heuristic that let one
      // of those through would report a phantom missing table for ever.
      // `is(value, PgTable)` rather than a duck-type check: the schema module
      // also exports enums, relations and helpers, and a heuristic that let one
      // of those through would report a phantom missing table for ever. The
      // union of every concrete table type is not assignable to `PgTable`, so
      // the narrowing is done with a plain filter and a cast at the boundary.
      const declared = Object.values(schema)
        .filter((value) => is(value, PgTable))
        .map((table) => getTableName(table as PgTable));

      const result = await db.execute<{ tablename: string }>(
        sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
      );
      const actual = new Set(result.rows.map((r) => r.tablename));

      const missing = [...new Set(declared)].filter((name) => !actual.has(name));

      expect(missing, 'Declared in schema.ts but never created by a migration').toEqual([]);
    });
  });
});
