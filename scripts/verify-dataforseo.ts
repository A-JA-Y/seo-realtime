/**
 * DataForSEO credential + location check — requirements.md §§6–7.
 *
 *   pnpm verify:dataforseo              balance, then resolve Indian locations
 *   pnpm verify:dataforseo --locations  locations only, no balance call
 *   pnpm verify:dataforseo --live       ALSO run one live SERP (costs $0.0020)
 *
 * The live SERP is opt-in because it spends real money. Everything else is
 * free. When you do run it, the raw response is written to
 * src/test/fixtures/ — the parser's unit tests need the real response shape,
 * including the fields DataForSEO returns inconsistently.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { dataForSeoAuthHeader } from '@/lib/env';
import { redactError } from '@/lib/redact';
import { LOCATIONS, SEED_KEYWORDS, SEED_PROPERTY } from '@/server/db/seed-data';

const BASE_URL = 'https://api.dataforseo.com';
const LIVE_SERP_COST_USD = 0.002;

/* ── Response schemas. External data is validated, never trusted. ─────────── */

const envelope = <T extends z.ZodTypeAny>(result: T) =>
  z.object({
    status_code: z.number(),
    status_message: z.string(),
    tasks: z
      .array(
        z.object({
          id: z.string().optional(),
          status_code: z.number(),
          status_message: z.string(),
          cost: z.number().optional(),
          result: z.union([result, z.null()]).optional(),
        }),
      )
      .optional(),
  });

const userDataResult = z.array(
  z.object({
    money: z.object({ balance: z.number(), total: z.number().optional() }).optional(),
    rates: z.object({ limits: z.object({ minute: z.number().optional() }).optional() }).optional(),
  }),
);

const locationsResult = z.array(
  z.object({
    location_code: z.number(),
    location_name: z.string(),
    location_code_parent: z.number().nullable().optional(),
    country_iso_code: z.string().nullable().optional(),
    location_type: z.string().nullable().optional(),
  }),
);

const serpItem = z
  .object({
    type: z.string(),
    rank_group: z.number().nullable().optional(),
    rank_absolute: z.number().nullable().optional(),
    domain: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
  })
  // DataForSEO adds item fields without notice; keeping the extras here is a
  // deliberate exception to the no-passthrough rule, because the raw payload is
  // exactly what we are trying to capture.
  .loose();

const serpResult = z.array(
  z.object({
    keyword: z.string(),
    location_code: z.number().optional(),
    items_count: z.number().nullable().optional(),
    items: z.array(serpItem).nullable().optional(),
  }),
);

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function heading(text: string) {
  console.log(`\n${text}\n${'─'.repeat(text.length)}`);
}
const pass = (t: string) => console.log(`  ✓ ${t}`);
const fail = (t: string) => console.log(`  ✗ ${t}`);

async function call<T extends z.ZodTypeAny>(
  endpoint: string,
  schema: T,
  body?: unknown,
): Promise<z.infer<ReturnType<typeof envelope<T>>>> {
  const response = await fetch(`${BASE_URL}${endpoint}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: dataForSeoAuthHeader(),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (response.status === 401) {
    throw new Error(
      'HTTP 401 — credentials rejected. DATAFORSEO_PASSWORD must be the API ' +
        'password from the dashboard, which is NOT your account login password.',
    );
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${endpoint}`);
  }

  const parsed = envelope(schema).safeParse(await response.json());
  if (!parsed.success) {
    throw new Error(`Unexpected response shape from ${endpoint}: ${parsed.error.issues[0]?.message}`);
  }
  return parsed.data;
}

/* ── Checks ───────────────────────────────────────────────────────────────── */

async function checkBalance(): Promise<boolean> {
  heading('A. appendix/user_data — credentials and balance');

  try {
    const data = await call('/v3/appendix/user_data', userDataResult);
    const balance = data.tasks?.[0]?.result?.[0]?.money?.balance;

    if (typeof balance !== 'number') {
      fail('Authenticated, but no balance in the response.');
      return false;
    }

    pass(`Credentials valid. Balance: $${balance.toFixed(2)}`);

    if (balance <= 0) {
      fail('Balance is zero — top up ($50 minimum) before any SERP call.');
      return false;
    }

    const perMonth = 13 * 2 * 4 * 30 * 0.0006; // this property's actual footprint
    console.log(`    At ~$${perMonth.toFixed(2)}/month for the seeded property,`);
    console.log(`    that is roughly ${Math.floor(balance / perMonth)} months of tracking.`);
    return true;
  } catch (error) {
    fail(redactError(error));
    return false;
  }
}

async function checkLocations(): Promise<boolean> {
  heading('B. serp/google/locations — resolve location codes');
  console.log('  Codes change. Never hardcode them, never copy them from a blog post.\n');

  try {
    const data = await call('/v3/serp/google/locations', locationsResult);
    const all = data.tasks?.[0]?.result ?? [];

    if (all.length === 0) {
      fail('No locations returned.');
      return false;
    }

    pass(`${all.length} locations available`);

    const indian = all.filter((l) => l.country_iso_code === 'IN');
    const relevant = indian.filter((l) => /noida|^india$|uttar pradesh|delhi/i.test(l.location_name));

    console.log('');
    for (const location of relevant.slice(0, 15)) {
      console.log(
        `    ${String(location.location_code).padEnd(9)} ${location.location_name}  (${location.location_type ?? '?'})`,
      );
    }

    // Compare against what the seed currently believes.
    heading('   Seed values in src/server/db/seed-data.ts');
    let stale = false;

    for (const [key, seeded] of Object.entries(LOCATIONS)) {
      const match = all.find((l) => l.location_code === seeded.locationCode);
      if (!match) {
        fail(`${key}: code ${seeded.locationCode} does NOT exist — update it from the list above.`);
        stale = true;
      } else if (match.location_name !== seeded.locationName) {
        fail(`${key}: code ${seeded.locationCode} is "${match.location_name}", seed says "${seeded.locationName}"`);
        stale = true;
      } else {
        pass(`${key}: ${seeded.locationCode} → ${match.location_name}`);
      }
    }

    if (stale) {
      console.log('\n    A stale code returns rankings for the wrong geography WITHOUT erroring.');
      console.log('    Fix src/server/db/seed-data.ts, then re-run `pnpm db:seed`.');
    }

    return !stale;
  } catch (error) {
    fail(redactError(error));
    return false;
  }
}

async function checkLiveSerp(): Promise<boolean> {
  const keyword = SEED_KEYWORDS[0]!.term;
  const location = LOCATIONS.noida;

  heading(`C. serp/google/organic/live/advanced — "${keyword}"`);
  console.log(`  location: ${location.locationName} (${location.locationCode}), mobile`);
  console.log(`  cost:     $${LIVE_SERP_COST_USD.toFixed(4)} — this call spends real money\n`);

  try {
    const raw = await fetch(`${BASE_URL}/v3/serp/google/organic/live/advanced`, {
      method: 'POST',
      headers: { Authorization: dataForSeoAuthHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify([
        {
          keyword,
          location_code: location.locationCode,
          language_code: 'en',
          device: 'mobile',
          os: 'android',
          depth: 100,
        },
      ]),
    });

    if (!raw.ok) throw new Error(`HTTP ${raw.status}`);
    const json: unknown = await raw.json();

    const parsed = envelope(serpResult).safeParse(json);
    if (!parsed.success) {
      fail(`Unexpected response shape: ${parsed.error.issues[0]?.message}`);
      return false;
    }

    const task = parsed.data.tasks?.[0];
    const items = task?.result?.[0]?.items ?? [];
    const organic = items.filter((i) => i.type === 'organic');

    pass(`${items.length} SERP elements, ${organic.length} organic`);

    // Registrable-hostname match, ignoring www. — not full-URL equality.
    const mine = organic.filter((i) =>
      (i.domain ?? '').replace(/^www\./, '').toLowerCase().endsWith(SEED_PROPERTY.domain),
    );

    console.log('');
    if (mine.length === 0) {
      console.log(`    ${SEED_PROPERTY.domain} is NOT in the top 100 for this keyword.`);
      console.log('    That is a valid result — it stores as found=false with NULL ranks,');
      console.log('    never as position 100.');
    } else {
      const best = [...mine].sort((a, b) => (a.rank_group ?? 999) - (b.rank_group ?? 999))[0]!;
      console.log(`    ${SEED_PROPERTY.domain}`);
      console.log(`      rank_group:    ${best.rank_group}   ← which blue link you are`);
      console.log(`      rank_absolute: ${best.rank_absolute}   ← how far down the page you are`);
      console.log(
        `      furniture gap: ${(best.rank_absolute ?? 0) - (best.rank_group ?? 0)} non-organic blocks above you`,
      );
      console.log(`      url:           ${best.url}`);
      if (mine.length > 1) console.log(`      (${mine.length} of your URLs rank; best shown)`);
    }

    const featureTypes = [...new Set(items.map((i) => i.type))].filter((t) => t !== 'organic');
    console.log(`\n    SERP features present: ${featureTypes.join(', ') || 'none'}`);

    console.log('\n    Competitors above you:');
    for (const item of organic.filter((i) => !mine.includes(i)).slice(0, 5)) {
      console.log(`      ${String(item.rank_group).padStart(3)}  ${item.domain}`);
    }

    // Commit the real shape so the parser tests are not written against a guess.
    const dir = path.join(process.cwd(), 'src/test/fixtures');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'dataforseo-live-advanced.json');
    await writeFile(file, JSON.stringify(json, null, 2));
    console.log(`\n    Raw response saved → ${path.relative(process.cwd(), file)}`);
    console.log('    Commit it. The parser tests run against this, not against a guess.');

    if (typeof task?.cost === 'number') console.log(`\n    Actual cost: $${task.cost.toFixed(4)}`);
    return true;
  } catch (error) {
    fail(redactError(error));
    return false;
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const locationsOnly = args.has('--locations');
  const live = args.has('--live');

  let ok = true;
  if (!locationsOnly) ok = (await checkBalance()) && ok;
  ok = (await checkLocations()) && ok;
  if (live) ok = (await checkLiveSerp()) && ok;

  heading('Result');
  if (ok) {
    pass('DataForSEO is correctly provisioned.');
    if (!live) {
      console.log('\n  Not yet verified: an actual SERP response.');
      console.log(`  Run \`pnpm verify:dataforseo --live\` to fetch one ($${LIVE_SERP_COST_USD.toFixed(4)})`);
      console.log('  and save it as a test fixture.\n');
    } else {
      console.log('\n  Next: requirements.md §8 — Neon Postgres.\n');
    }
  } else {
    fail('Some checks failed — see the hints above.\n');
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(`\n  ✗ ${redactError(error)}\n`);
  process.exit(1);
});
