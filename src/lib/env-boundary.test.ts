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

function gitGrep(pattern: string, paths: string[]): Match[] {
  let raw = '';
  try {
    raw = execFileSync('git', ['grep', '-n', '-I', '-E', '--', pattern, ...paths], {
      encoding: 'utf8',
      cwd: process.cwd(),
    });
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

    const offenders = excludingTests(
      excludingComments(
        gitGrep('process\\.env', ['src', 'scripts', 'drizzle.config.ts', 'next.config.ts']),
      ),
    ).filter((m) => !ALLOWED.has(m.file));

    expect(
      format(offenders),
      'Import the typed `env` (or `requireEnv` for a narrow slice) from @/lib/env instead',
    ).toEqual([]);
  });

  it('uses no explicit `any`', () => {
    const offenders = excludingComments(
      gitGrep(':[[:space:]]*any\\b|<any>|\\bas any\\b', ['src', 'scripts']),
    );

    expect(format(offenders), 'Use `unknown` and narrow it, or write the real type').toEqual([]);
  });

  it('never writes a literal 100 as a rank fallback', () => {
    // Domain rule 5 / acceptance criterion 4: "not found" is not position 100.
    // This catches the specific shape of that mistake, e.g. `rankGroup ?? 100`.
    const offenders = excludingComments(
      gitGrep('(rank|position)[A-Za-z]*[[:space:]]*(\\?\\?|\\|\\|)[[:space:]]*100\\b', ['src']),
    );

    expect(
      format(offenders),
      'A missing rank is NULL with found=false. A sentinel corrupts every aggregate downstream.',
    ).toEqual([]);
  });
});
