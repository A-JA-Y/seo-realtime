import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

/**
 * §2: "Validate process.env once at startup through a Zod schema in
 * src/lib/env.ts and import typed values from there. Never read process.env
 * anywhere else in the codebase."
 *
 * §16 lists a stray `process.env` read, and `any`, as explicit anti-patterns.
 * A rule that is only written down gets broken. This is the rule as a test, so
 * a violation fails CI instead of surviving review.
 */

interface Match {
  file: string;
  lineNumber: number;
  text: string;
}

/** This file names the patterns it searches for, so it always matches itself. */
const SELF = 'src/lib/env-boundary.test.ts';

function gitGrep(pattern: string, paths: string[]): Match[] {
  let raw = '';
  try {
    // --untracked matters: without it `git grep` searches only committed files,
    // so brand-new work — exactly the code most likely to contain a fresh
    // violation — would sail past this guard until someone committed it.
    raw = execFileSync(
      'git',
      ['grep', '-n', '-I', '-E', '--untracked', '--', pattern, ...paths],
      { encoding: 'utf8', cwd: process.cwd() },
    );
  } catch (error) {
    // git grep exits 1 when nothing matches, which is a pass, not a failure.
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }

  return raw
    .split('\n')
    .filter(Boolean)
    .map((entry) => {
      const [file = '', lineNumber = '0', ...rest] = entry.split(':');
      return { file, lineNumber: Number(lineNumber), text: rest.join(':').trim() };
    });
}

/** Drop matches that are inside a comment — prose is allowed to name the rule. */
function excludingComments(matches: Match[]): Match[] {
  return matches.filter((m) => !/^(\/\/|\/\*|\*)/.test(m.text));
}

/** Test files legitimately construct and mutate the environment under test. */
function excludingTests(matches: Match[]): Match[] {
  return matches.filter((m) => !m.file.endsWith('.test.ts'));
}

function excludingSelf(matches: Match[]): Match[] {
  return matches.filter((m) => m.file !== SELF);
}

const format = (matches: Match[]) => matches.map((m) => `${m.file}:${m.lineNumber}  ${m.text}`);

describe('anti-pattern guards', () => {
  it('reads process.env only in src/lib/env.ts', () => {
    const ALLOWED = new Set([
      // The schema's own reader. This is the boundary.
      'src/lib/env.ts',
      // Test bootstrap: WRITES fallbacks before any module reads them.
      'src/test/setup.ts',
      // drizzle-kit runs outside the Next runtime and cannot import the app
      // module graph just to generate SQL. Documented in NOTES.md §5.
      'drizzle.config.ts',
    ]);

    const offenders = excludingSelf(
      excludingTests(
        excludingComments(
          gitGrep('process\\.env', ['src', 'scripts', 'drizzle.config.ts', 'next.config.ts']),
        ),
      ),
    ).filter((m) => !ALLOWED.has(m.file));

    expect(
      format(offenders),
      'Import the typed `env` (or `requireEnv` for a narrow slice) from @/lib/env instead',
    ).toEqual([]);
  });

  it('uses no explicit `any`', () => {
    const offenders = excludingSelf(
      excludingComments(gitGrep(':[[:space:]]*any\\b|<any>|\\bas any\\b', ['src', 'scripts'])),
    );

    expect(format(offenders), 'Use `unknown` and narrow it, or write the real type').toEqual([]);
  });

  it('routes never reach past the scoped query layer', () => {
    /*
     * §10: "Route every query through a `forProperty(propertyId)` builder so
     * writing an unscoped query is structurally difficult rather than merely
     * discouraged."
     *
     * A route that imports the raw `db` handle can query any tenant's rows with
     * no access check, and nothing in the type system objects. This is that
     * rule as a test.
     *
     * Exempt: the machine-authenticated endpoints. `api/cron` and
     * `api/webhooks` are called by schedulers and DataForSEO with their own
     * shared secrets and no session at all — they legitimately operate across
     * every tenant. `api/health` reads only schema metadata, and `api/auth` is
     * Auth.js's own handler.
     */
    const EXEMPT = /^src\/app\/api\/(cron|webhooks|health|auth)\//;

    const offenders = excludingSelf(
      excludingTests(excludingComments(gitGrep("from '@/server/db'", ['src/app']))),
    ).filter((m) => !EXEMPT.test(m.file));

    expect(
      format(offenders),
      'Use forProperty(principal, propertyId) or accessibleProperties(principal) instead of the raw db handle',
    ).toEqual([]);
  });

  it('never writes a literal 100 as a rank fallback', () => {
    // Domain rule 5 / acceptance criterion 4: "not found" is not position 100.
    // This catches the specific shape of that mistake, e.g. `rankGroup ?? 100`.
    const offenders = excludingSelf(
      excludingComments(
        gitGrep('(rank|position)[A-Za-z]*[[:space:]]*(\\?\\?|\\|\\|)[[:space:]]*100\\b', ['src']),
      ),
    );

    expect(
      format(offenders),
      'A missing rank is NULL with found=false. A sentinel corrupts every aggregate downstream.',
    ).toEqual([]);
  });
});
