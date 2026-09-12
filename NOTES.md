# Implementation notes — deliberate deviations from the build prompt

Every item here is a place where following the prompt literally would have
produced a bug or a deploy failure. Each says what changed and why.

---

## 1. `gsc_snapshots` unique constraint uses `NULLS NOT DISTINCT`

**Prompt (§4):**

```sql
UNIQUE (keyword_id, gsc_date, gsc_hour, data_state)
```

**Problem.** In Postgres, `NULL` values in a unique constraint are *distinct*
from one another by default. `gsc_hour` is `NULL` on every `fresh` and `final`
row (§5 says reconciliation writes `gsc_hour = NULL`). So for daily rows the
constraint can never fire: `ON CONFLICT DO UPDATE` never triggers, and running
`reconcile-gsc` twice writes two rows instead of updating one.

That breaks domain rule 9 ("every ingest is idempotent") and acceptance
criterion 2 ("running `ingest-gsc` twice in a row produces identical row
counts") — silently, with no error.

**Change.** The constraint is emitted as:

```sql
UNIQUE NULLS NOT DISTINCT (keyword_id, gsc_date, gsc_hour, data_state)
```

Postgres 15+ syntax; Neon runs 17. Two `NULL` hours now collide as intended.
The alternative — a sentinel hour such as `-1` for daily rows — was rejected
because it repeats the mistake domain rule 5 warns about.

## 2. `bcryptjs` instead of native `bcrypt`

Same algorithm, same cost factor (12), same `$2a$`/`$2b$` output format.
Native `bcrypt` needs a node-gyp compile that fails on Vercel's build image and
inflates the serverless bundle. Cost 12 as specified.

## 3. One Vercel cron slot, chaining three daily jobs

The prompt's §7 table lists three daily jobs (`reconcile-gsc` 04:00,
`rollup` 04:30, `prune` 05:00). Vercel Hobby's cron allowance is small and has
varied between 1 and 2 jobs per project across plan revisions; acceptance
criterion 11 requires the deploy to succeed on Hobby.

`vercel.json` therefore registers exactly **one** daily cron,
`/api/cron/daily`, which runs `reconcile-gsc` → `rollup` → `prune` in sequence
and records an `ingest_runs` row per step. Each step remains individually
addressable (`/api/cron/rollup` etc.) for the external scheduler and for manual
re-runs. This is Hobby-safe under any of the published limits.

## 4. `GOOGLE_PRIVATE_KEY` newline unescaping happens in `src/lib/env.ts`

§5's snippet shows `.replace(/\\n/g, '\n')` at the call site in `gscClient()`.
Doing it in the Zod schema instead means the key is normalised exactly once,
at the single boundary where env is read, and no future caller can forget it.
The transform is idempotent, so an already-unescaped key passes through
unchanged.

## 5. `drizzle.config.ts` reads `process.env` directly

§2 says "never read `process.env` anywhere else in the codebase." drizzle-kit
runs as a standalone CLI outside the Next.js runtime; importing `src/lib/env.ts`
there would pull the app's module graph into the migration tool and require
every runtime secret to be present just to generate SQL. The config file reads
the two database URLs directly and is the only exception. `src/lib/env.ts`
itself also reads `process.env` — that is the point of it.

## 6. Recharts 3.x

`recharts@2` is published as deprecated on npm. 3.x is current and keeps the
`reversed` / `connectNulls` APIs that §11's chart requirements depend on.

## 7. The database handle falls back to node-postgres off Neon

§2 specifies the Neon serverless driver, and that is what production uses:
`src/server/db/index.ts` picks it whenever `DATABASE_URL` points at a
`*.neon.tech` host, which in production it always does.

Any other host falls back to `node-postgres`. The reason is testability. §13
requires integration tests covering idempotent ingest, reconciliation and
cross-tenant isolation, and the Neon HTTP driver can only talk to Neon — so
without this, none of those tests can run in CI, in a pre-commit hook, or on a
machine without a Neon account. With it, `TEST_DATABASE_URL` can point at a Neon
`dev` branch or at a throwaway local Postgres, and the suite exercises the real
query builder either way.

`pg` is a devDependency, so it is not installed in the production bundle. The
branch that would load it cannot be reached there.

The handle is typed as `NeonHttpDatabase` rather than as a union of the two.
A union collapses the `.returning()` overloads and breaks typing at every call
site; declaring the Neon type is also the conservative choice, because it
advertises no interactive transactions — the constraint production actually
runs under.

## 8. Environment validation is deferred to first access, not module load

§2 says to validate `process.env` "once at startup". `src/lib/env.ts` still
validates once and caches, but the parse is triggered by the first property
read rather than by module evaluation.

The reason is the setup flow this repo is supposed to support. `requirements.md`
walks through Google, then DataForSEO, then Neon, then Vercel, then Auth.js, and
each stage ends in a verification command. With eager whole-environment
validation, `pnpm verify:gsc` would fail on a missing `DATAFORSEO_PASSWORD`
before it ever reached Google — making the guide impossible to follow in the
order it is written. The verify scripts call `requireEnv(...)` for the narrow
slice they need.

For the application itself nothing changes in practice: the first access
happens while a server module initialises, so a bad environment still fails
immediately and loudly.

---

# M2 — Search Console ingestion

## 9. `data_state = 'fresh'` has a writer, which §5 never specified

The `gsc_data_state` enum is `('hourly','fresh','final')` and §5's read
resolution is explicitly "final where it exists, else fresh, else the
impression-weighted aggregate of that date's hourly rows". But §5 names only
two writers: the hourly job (`hourly_all` → `'hourly'`) and reconciliation
(`final` → `'final'`). Nothing produces `'fresh'`.

**Change.** The hourly job also issues one request per keyword with
`dimensions: ["date","query"]` and `dataState: "all"` over T−3…T−0, written as
`data_state = 'fresh'`, `gsc_hour = NULL`.

**Why, rather than leaving the enum value unwritten.** Reconciliation settles
exactly T−4. Without a `fresh` writer, the daily figure for T−3, T−2, T−1 and
T−0 is *our* impression-weighted aggregate of whatever hour buckets Google
happened to return — which understates total impressions and biases the
position toward the keyword's busiest hours. Worse, that understatement is
self-concealing: domain rule 6's low-confidence check keys off the same
impression count, so the number that is wrong is also the number that decides
whether to trust it. `dataState: "all"` is a daily figure Google computed over
the whole day.

The cost is one extra request per keyword per hour. Search Console requests are
free and the quota is 1,200/minute per site.

## 10. CHECK constraints on `gsc_snapshots`

Five constraints, added in `drizzle/0001_gsc_ingest.sql`:

| Constraint | Enforces |
|---|---|
| `no_position_without_impressions` | `impressions > 0 OR position IS NULL` |
| `position_range` | `position IS NULL OR position >= 1` |
| `counts_nonnegative` | `clicks >= 0 AND impressions >= 0` |
| `hour_range` | `gsc_hour IS NULL OR gsc_hour BETWEEN 0 AND 23` |
| `hour_matches_state` | `(data_state = 'hourly') = (gsc_hour IS NOT NULL)` |

These are the invariants the read resolver would otherwise have to detect and
report at runtime. Enforcing them in the database makes the violating rows
*unstorable*, which converts a class of silent wrong answers into a loud write
failure at the point the bad data was produced.

`position >= 1` is the one that earns its keep: position 0 does not exist, and a
0 stored here renders *above* position 1 on the inverted rank axis §11 requires
— better than first place. The mapper drops a sub-1 position to NULL and logs
it rather than letting the write fail.

All five are verified against a live Postgres 16, rejecting the bad rows and
accepting the legitimate ones.

## 11. Backfill progress is a new table, keyed per keyword

`gsc_backfill_cursors (keyword_id PK, property_id, covered_from, covered_through,
completed_at, updated_at)`.

Two designs were rejected:

**Derive progress from `gsc_snapshots`** (`MIN(gsc_date)` per keyword) needs no
new state, and is wrong. That table records only *positive* observations —
Google omits dates with no impressions entirely — so a window in which a keyword
had no traffic writes no rows, `MIN(gsc_date)` does not advance, and the walk
either loops or redoes the same window forever.

**A single `properties.gsc_backfill_cursor`** is simpler, and leaves a keyword
added *after* the property finished backfilling permanently blank: the property
is already marked done. §10 exposes `POST /api/properties/:id/keywords`, so
that is a routine operation, not an edge case. There is a test for it.

`properties.backfilled_at` still exists and still means what §5 says — it is set
once every one of the property's keywords has reached the retention floor, and
a re-run does not move it.

## 12. `properties.gsc_dimension_mode` and `gsc_dimension_probed_at`

§5 requires probing whether `date` and `hour` may be grouped in one request, and
caching the answer: "do not retry the failing shape every hour."

The cache has to be durable. Every cron invocation is a cold serverless process,
so a module-level memo caches nothing across invocations — it would re-probe
every hour, which is precisely what the spec forbids.

Scoped per property rather than globally. The capability is probably uniform
across the API, but assuming so and being wrong means one property silently
stops ingesting; assuming per-property and being wrong costs one redundant
probe per property, once.

A `per_date` answer is re-probed after 30 days, so a downgrade is not permanent
if Google starts accepting the combined shape. Only an HTTP **400** triggers the
fallback — a 5xx is transient and must not downgrade the property, which is
tested.

## 13. `gsc_hour` is a clock LABEL, not an elapsed hour

Verified against `date-fns-tz`, not reasoned about:

| Pacific date | Elapsed hours | Distinct `gsc_hour` labels |
|---|---|---|
| 2026-03-08 (spring forward) | 23 | 23 — 02:00 never happens |
| 2026-06-15 (ordinary) | 24 | 24 |
| 2026-11-01 (fall back) | **25** | **24** — 01:00 happens twice |

The fall-back day is the trap. It is 25 hours long, but `gsc_hour` is a
`SMALLINT` 0–23, so two real hours share label 1. Two consequences:

1. `pacificHourLabelsInDay` returns 24 for that day, not 25. Returning 25 would
   make every fall-back day render as permanently incomplete.
2. Two API rows can collapse onto one natural key. Postgres refuses
   `ON CONFLICT DO UPDATE` when a single statement touches the same row twice
   ("cannot affect row a second time"), so leaving them in a batch does not
   merely lose precision — it throws and loses the whole batch. `mergeDuplicates`
   sums clicks and impressions and impression-weights the positions, which is
   the honest reading: the label covered both hours.

Whether Google actually returns two buckets that day is unknown, and depends on
the `hour` key format — an ISO timestamp carries distinct offsets (`-07:00` and
`-08:00`) and would disambiguate; a bare `"1"` would not. `pnpm verify:gsc
--save-fixtures` captures the real format.

## 14. Search Console fixtures are hand-written, not captured

`src/test/fixtures/gsc/*.json` were written from Google's Search Analytics
reference because no credentials exist in the build environment. They are
labelled as synthetic in `src/test/fixtures/README.md`, and
`pnpm verify:gsc --save-fixtures` replaces them with real captures.

The specific open question is the `hour` dimension key format: Google's
reference does not state whether it is a bare `"13"` or a full
`"2026-09-12T13:00:00-07:00"`. `parseHourKey` handles both and takes the hour
*literally* out of the string rather than parsing it into a `Date` — a `Date`
round trip converts through the runtime's local zone and silently shifts the
hour, which is the class of bug domain rule 4 forbids.
