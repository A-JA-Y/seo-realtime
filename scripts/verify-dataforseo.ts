import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  COST_PER_SERP,
  createDataForSeoClient,
  isTaskOk,
} from '@/server/ingest/dataforseo-client';
import { redactError } from '@/lib/redact';
import { parseSerpResult } from '@/server/ingest/serp-parse';
import { LOCATIONS, SEED_KEYWORDS, SEED_PROPERTY } from '@/server/db/seed-data';

const LIVE_SERP_COST_USD = COST_PER_SERP.live;

/**
 * Uses the SAME client and parser the ingest does.
 *
 * A setup checker with its own HTTP code and its own parsing can pass while the
 * real ingest fails — which is the opposite of what a setup checker is for.
 */
/**
 * The raw body of the last response, captured before Zod touches it.
 *
 * The whole point of saving a fixture is to record the REAL shape, including
 * the fields our schemas strip. Writing the parsed envelope back out would
 * produce a fixture that agrees with our assumptions by construction — it would
 * pass every test while telling us nothing about what DataForSEO actually
 * sends, which is the one question fixtures exist to answer.
 */
let lastRawBody: string | null = null;

const capturingFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  // Tee the body: Response bodies are single-use, so read it here and hand the
  // caller a fresh Response over the same bytes.
  const body = await response.text();
  lastRawBody = body;
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

const client = createDataForSeoClient({ fetchImpl: capturingFetch });

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function heading(text: string) {
  console.log(`\n${text}\n${'─'.repeat(text.length)}`);
}
const pass = (t: string) => console.log(`  ✓ ${t}`);
const fail = (t: string) => console.log(`  ✗ ${t}`);

/* ── Checks ───────────────────────────────────────────────────────────────── */

async function checkBalance(): Promise<boolean> {
  heading('A. appendix/user_data — credentials and balance');

  try {
    const balance = await client.balance();

    if (typeof balance !== 'number') {
      fail('Authenticated, but no balance in the response.');
      return false;
    }

    pass(`Credentials valid. Balance: $${balance.toFixed(2)}`);

    if (balance <= 0) {
      fail('Balance is zero — top up ($50 minimum) before any SERP call.');
      return false;
    }

    /*
     * The seeded property's ACTUAL footprint, read from the seed definition
     * rather than assumed: primary keywords check every 6 hours (4/day) and the
     * rest every 12 (2/day), across two targets each.
     */
    const primaries = SEED_KEYWORDS.filter((k) => k.isPrimary).length;
    const secondaries = SEED_KEYWORDS.length - primaries;
    const targetsPerKeyword = 2;
    const checksPerDay = (primaries * 4 + secondaries * 2) * targetsPerKeyword;
    const perMonth = checksPerDay * 30 * COST_PER_SERP.standard;
    console.log(
      `    At ~$${perMonth.toFixed(2)}/month for the seeded property ` +
        `(${checksPerDay} checks/day on the standard queue),`,
    );
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
    const all = await client.locations();

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
    const envelope = await client.liveAdvanced({
      keyword,
      location_code: location.locationCode,
      language_code: 'en',
      device: 'mobile',
      os: 'android',
      depth: 100,
      tag: 'verify',
    });

    const task = envelope.tasks?.[0];
    if (!task || !isTaskOk(task.status_code)) {
      fail(`Provider returned ${task?.status_code ?? 'no task'}: ${task?.status_message ?? ''}`);
      return false;
    }

    const result = task.result?.[0];
    if (!result) {
      fail('Live call returned no result.');
      return false;
    }

    const items = result.items ?? [];
    pass(`${items.length} SERP elements`);

    // The REAL parser, not a second implementation. If this disagrees with
    // what the ingest would store, the check has told you nothing.
    const parsed = parseSerpResult(result, SEED_PROPERTY.domain);

    console.log('');
    if (!parsed.found) {
      console.log(`    ${SEED_PROPERTY.domain} is NOT in the top 100 for this keyword.`);
      console.log('    That is a valid result — it stores as found=false with NULL ranks,');
      console.log('    never as position 100.');
    } else {
      console.log(`    ${SEED_PROPERTY.domain}`);
      console.log(`      rank_group:    ${parsed.rankGroup}   ← which blue link you are`);
      console.log(`      rank_absolute: ${parsed.rankAbsolute}   ← how far down the page you are`);
      console.log(
        `      furniture gap: ${(parsed.rankAbsolute ?? 0) - (parsed.rankGroup ?? 0)} non-organic blocks above you`,
      );
      console.log(`      url:           ${parsed.rankingUrl}`);
      if (parsed.allRankingUrls.length > 1) {
        console.log(`      (${parsed.allRankingUrls.length} of your URLs rank; best shown)`);
      }
    }

    const present = Object.entries(parsed.serpFeatures)
      .filter(([, v]) => v === true || (typeof v === 'number' && v > 0))
      .map(([k, v]) => (typeof v === 'number' ? `${k}=${v}` : k));
    console.log(`\n    SERP features present: ${present.join(', ') || 'none'}`);

    /*
     * competingDomains is the top 10 organic results, not "those above us".
     * Labelling it as the latter would be a small lie in a tool whose entire
     * premise is labelled numbers.
     */
    const above =
      parsed.rankGroup === null
        ? parsed.competingDomains
        : parsed.competingDomains.filter(
            (c) => c.rank_group !== null && c.rank_group < parsed.rankGroup!,
          );

    console.log(
      `\n    ${parsed.rankGroup === null ? 'Top organic results' : 'Organic results above you'}:`,
    );
    for (const competitor of above.slice(0, 5)) {
      console.log(`      ${String(competitor.rank_group).padStart(3)}  ${competitor.domain}`);
    }
    if (above.length === 0) console.log('      (none — you are the top organic result)');

    // Commit the RAW shape, not the parsed one.
    const dir = path.join(process.cwd(), 'src/test/fixtures/dataforseo');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'live-advanced-real.json');

    if (lastRawBody === null) {
      fail('No raw response was captured; not writing a fixture from parsed output.');
    } else {
      // Pretty-print the raw bytes, preserving every field our schemas strip.
      await writeFile(file, JSON.stringify(JSON.parse(lastRawBody), null, 2));
      console.log(`\n    Raw response saved → ${path.relative(process.cwd(), file)}`);
      console.log('    Commit it — the committed fixtures are hand-written until you do.');

      const strippedFields = countStrippedFields(JSON.parse(lastRawBody), envelope);
      if (strippedFields > 0) {
        console.log(
          `    (${strippedFields} field(s) in the real response are stripped by our schemas — ` +
            'exactly why the raw body is what gets saved.)',
        );
      }
    }

    if (typeof task.cost === 'number') console.log(`\n    Actual cost: $${task.cost.toFixed(4)}`);
    return true;
  } catch (error) {
    fail(redactError(error));
    return false;
  }
}

/** How many keys the raw response carries that the parsed one does not. */
function countStrippedFields(raw: unknown, parsed: unknown): number {
  if (raw === null || typeof raw !== 'object' || parsed === null || typeof parsed !== 'object') {
    return 0;
  }

  if (Array.isArray(raw)) {
    if (!Array.isArray(parsed)) return 0;
    return raw.reduce<number>((n, item, i) => n + countStrippedFields(item, parsed[i]), 0);
  }

  const rawKeys = Object.keys(raw as Record<string, unknown>);
  const parsedRecord = parsed as Record<string, unknown>;
  let count = 0;

  for (const key of rawKeys) {
    if (!(key in parsedRecord)) count++;
    else count += countStrippedFields((raw as Record<string, unknown>)[key], parsedRecord[key]);
  }

  return count;
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
