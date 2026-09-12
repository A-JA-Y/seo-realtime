/**
 * Search Console credential check — requirements.md §4.
 *
 *   pnpm verify:gsc
 *
 * Deliberately narrow: it validates only the two Google variables, so it runs
 * before DataForSEO, Neon or Auth.js have been provisioned. Setup has to be
 * followable in order.
 *
 * It also answers the one thing Google does not document — whether `date` and
 * `hour` may be grouped in a single request — because the hourly ingest needs
 * that answer and guessing wrong costs an hour of silent no-ops.
 *
 *   pnpm verify:gsc                   check credentials and probe
 *   pnpm verify:gsc --save-fixtures   ALSO write the real responses to
 *                                     src/test/fixtures/gsc/, replacing the
 *                                     hand-written ones the parser tests
 *                                     currently run against
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { JWT } from 'google-auth-library';

import { requireEnv } from '@/lib/env';
import { redactError } from '@/lib/redact';
import { pacificToday } from '@/lib/gsc-dates';
import { SEED_KEYWORDS, SEED_PROPERTY } from '@/server/db/seed-data';

const SCOPES = ['https://www.googleapis.com/auth/webmasters.readonly'];

function heading(text: string) {
  console.log(`\n${text}\n${'─'.repeat(text.length)}`);
}

function pass(text: string) {
  console.log(`  ✓ ${text}`);
}

function fail(text: string) {
  console.log(`  ✗ ${text}`);
}

/**
 * Map a failure to the specific fix, rather than printing every hint every
 * time. The whole value of a setup checker is telling you which of six
 * plausible causes it actually is.
 */
function explain(message: string): string[] {
  if (/DECODER routines|PEM routines|asn1|Invalid keyData/i.test(message)) {
    return [
      'The private key is not being parsed as PEM.',
      'In .env.local, wrap GOOGLE_PRIVATE_KEY in DOUBLE QUOTES so the \\n',
      'escapes survive dotenv parsing. Copy the `private_key` field from the',
      'service-account JSON verbatim, BEGIN/END lines included.',
    ];
  }
  if (/has not been used in project|is disabled/i.test(message)) {
    return [
      'The Search Console API is not enabled on this Cloud project.',
      'Enable it: requirements.md §1.3',
    ];
  }
  if (/sufficient permission for site/i.test(message)) {
    return [
      'Either the service account is not a user on this property, or the',
      'siteUrl string does not match Search Console exactly (trailing slash,',
      'or the sc-domain: prefix). See requirements.md §3.',
    ];
  }
  if (/invalid_grant/i.test(message)) {
    return [
      'Clock skew or a deleted key. Check the system time, then recreate the',
      'key in the service account\'s Keys tab.',
    ];
  }
  if (/Invalid dataState/i.test(message)) {
    return ['dataState is lowercase: `hourly_all`.'];
  }
  if (/\b40[13]\b/.test(message)) {
    return ['Authentication or authorisation failure — re-check §§2 and 3.'];
  }
  return ['Unrecognised failure. The message above is verbatim from Google.'];
}

function printExplanation(message: string) {
  for (const line of explain(message)) console.log(`    → ${line}`);
}

const SAVE_FIXTURES = process.argv.slice(2).includes('--save-fixtures');
const FIXTURE_DIR = path.join(process.cwd(), 'src/test/fixtures/gsc');

/**
 * Persist a genuine response.
 *
 * The committed Search Console fixtures are hand-written from Google's
 * reference, because no credentials existed when the parser was built. Any test
 * asserting on response SHAPE is therefore testing an assumption until this has
 * run — the `hour` key format in particular.
 */
async function saveFixture(name: string, body: unknown) {
  if (!SAVE_FIXTURES) return;
  await mkdir(FIXTURE_DIR, { recursive: true });
  const file = path.join(FIXTURE_DIR, `${name}.json`);
  await writeFile(file, JSON.stringify(body, null, 2));
  console.log(`    saved → ${path.relative(process.cwd(), file)}`);
}

async function main() {
  const { GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY } = requireEnv(
    'GOOGLE_SERVICE_ACCOUNT_EMAIL',
    'GOOGLE_PRIVATE_KEY',
  );

  // The key is already unescaped by src/lib/env.ts — the single place that
  // handles it, so no call site can forget.
  const auth = new JWT({
    email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: GOOGLE_PRIVATE_KEY,
    scopes: SCOPES,
  });

  let failures = 0;

  /* ── A: which properties can this service account see? ──────────────────── */

  heading('A. sites.list — properties visible to the service account');

  let siteUrls: string[] = [];
  try {
    const response = await auth.request<{
      siteEntry?: Array<{ siteUrl: string; permissionLevel: string }>;
    }>({ url: 'https://www.googleapis.com/webmasters/v3/sites' });

    const entries = response.data.siteEntry ?? [];

    if (entries.length === 0) {
      fail('No properties. The service account exists but has not been added to any.');
      console.log(`    Add ${GOOGLE_SERVICE_ACCOUNT_EMAIL} as a Restricted user:`);
      console.log('    Search Console → Settings → Users and permissions → Add user');
      failures++;
    } else {
      pass(`${entries.length} propert${entries.length === 1 ? 'y' : 'ies'} visible`);
      console.log('');
      for (const entry of entries) {
        console.log(`    ${entry.siteUrl}`);
        console.log(`      permissionLevel: ${entry.permissionLevel}`);
      }
      console.log('');
      console.log('    Copy the siteUrl string above verbatim into');
      console.log('    src/server/db/seed-data.ts → SEED_PROPERTY.gscSiteUrl');
      console.log('    (trailing slash and sc-domain: prefix are part of the identifier)');
      siteUrls = entries.map((e) => e.siteUrl);
    }
  } catch (error) {
    const message = redactError(error);
    fail(`sites.list failed: ${message}`);
    printExplanation(message);

    // Every later call uses the same credential, so there is nothing to learn
    // from watching it fail three more times.
    console.log('\n  Skipping the remaining checks until this is fixed.\n');
    process.exitCode = 1;
    return;
  }

  /* ── B: can we actually read Search Analytics? ──────────────────────────── */

  const siteUrl =
    siteUrls.find((u) => u === SEED_PROPERTY.gscSiteUrl) ?? siteUrls[0] ?? SEED_PROPERTY.gscSiteUrl;
  const keyword = SEED_KEYWORDS[0]!.term;
  const today = pacificToday();
  const encoded = encodeURIComponent(siteUrl);

  heading(`B. searchAnalytics/query — hourly_all for "${keyword}"`);
  console.log(`  site: ${siteUrl}`);
  console.log(`  date: ${today} (Pacific Time — not your local date)\n`);

  const queryFilter = {
    dimensionFilterGroups: [
      {
        groupType: 'and',
        filters: [{ dimension: 'query', operator: 'equals', expression: keyword }],
      },
    ],
  };

  async function query(body: Record<string, unknown>) {
    return auth.request<{ rows?: Array<{ keys?: string[]; impressions?: number; position?: number }> }>({
      url: `https://www.googleapis.com/webmasters/v3/sites/${encoded}/searchAnalytics/query`,
      method: 'POST',
      data: body,
    });
  }

  try {
    const response = await query({
      startDate: today,
      endDate: today,
      dimensions: ['hour', 'query'],
      dataState: 'hourly_all',
      rowLimit: 25000,
      ...queryFilter,
    });

    const rows = response.data.rows ?? [];
    pass(`HTTP 200, ${rows.length} row(s)`);
    await saveFixture('real-hourly-per-date', response.data);

    // The undocumented bit the parser has to survive: is the `hour` key a bare
    // 0-23 string, or a full ISO timestamp at the Pacific offset?
    const sampleHourKey = rows[0]?.keys?.[0];
    if (sampleHourKey !== undefined) {
      console.log('');
      console.log(`    hour key format: ${JSON.stringify(sampleHourKey)}`);
      console.log(
        /^\d{1,2}$/.test(sampleHourKey)
          ? '    → bare hour. parseHourKey handles this.'
          : '    → ISO timestamp; it carries its own date. parseHourKey handles this too.',
      );
    }

    if (rows.length === 0) {
      console.log('    An empty rows array is still a PASS — it means no impressions yet today.');
    } else {
      console.log('');
      for (const row of rows.slice(0, 5)) {
        console.log(
          `    hour=${row.keys?.[0] ?? '?'}  impressions=${row.impressions ?? 0}  position=${row.position?.toFixed(1) ?? 'null'}`,
        );
      }
      if (rows.length > 5) console.log(`    … ${rows.length - 5} more`);
    }
  } catch (error) {
    const message = redactError(error);
    fail(`searchAnalytics/query failed: ${message}`);
    printExplanation(message);
    failures++;
  }

  /* ── C: the undocumented bit — date + hour in one request ───────────────── */

  heading('C. Probe: are ["date","hour","query"] allowed in one request?');
  console.log('  Google documents neither that this works nor that it does not.');
  console.log('  The hourly ingest implements both shapes; this decides which it uses.\n');

  const yesterday = pacificToday(-1);

  try {
    const response = await query({
      startDate: yesterday,
      endDate: today,
      dimensions: ['date', 'hour', 'query'],
      dataState: 'hourly_all',
      rowLimit: 25000,
      ...queryFilter,
    });
    pass(`Combined shape ACCEPTED — ${response.data.rows?.length ?? 0} row(s) across 2 days`);
    console.log('    One request per keyword covers the whole window.');
    await saveFixture('real-hourly-combined', response.data);
  } catch (error) {
    const message = redactError(error);
    if (/\b400\b/.test(message)) {
      console.log('  ℹ Combined shape REJECTED with 400 — expected on some properties.');
      console.log('    The ingest will fall back to one request per date with');
      console.log('    dimensions ["hour","query"], which call B just proved works.');
      console.log('    This is not a failure.');
    } else {
      fail(`Probe failed for an unexpected reason: ${message}`);
      printExplanation(message);
      failures++;
    }
  }

  /* ── Summary ────────────────────────────────────────────────────────────── */

  heading('Result');
  if (failures === 0) {
    pass('Search Console is correctly provisioned.');
    if (!SAVE_FIXTURES) {
      console.log('\n  The committed GSC fixtures are hand-written, not captured.');
      console.log('  Run `pnpm verify:gsc --save-fixtures` to replace them with real');
      console.log('  responses, then commit them — see src/test/fixtures/README.md.');
    }
    console.log('\n  Next: requirements.md §5 — DataForSEO, then `pnpm verify:dataforseo`.\n');
  } else {
    fail(`${failures} check(s) failed. Fix these before building — see the hints above.\n`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(`\n  ✗ ${redactError(error)}\n`);
  process.exit(1);
});
