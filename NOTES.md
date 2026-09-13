# Implementation notes — deliberate deviations from the build prompt

Every item here is a place where following the prompt literally would have
produced a bug or a deploy failure. Each says what changed and why.

---

## 1. `gsc_snapshots` unique constraint uses `NULLS NOT DISTINCT`

**Prompt (§4):**

```sql
UNIQUE (keyword_id, gsc_date, gsc_hour, data_state)
```

**Problem.** In Postgres, `NULL` values in a unique constraint are _distinct_
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
T−0 is _our_ impression-weighted aggregate of whatever hour buckets Google
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

| Constraint                        | Enforces                                           |
| --------------------------------- | -------------------------------------------------- |
| `no_position_without_impressions` | `impressions > 0 OR position IS NULL`              |
| `position_range`                  | `position IS NULL OR position >= 1`                |
| `counts_nonnegative`              | `clicks >= 0 AND impressions >= 0`                 |
| `hour_range`                      | `gsc_hour IS NULL OR gsc_hour BETWEEN 0 AND 23`    |
| `hour_matches_state`              | `(data_state = 'hourly') = (gsc_hour IS NOT NULL)` |

These are the invariants the read resolver would otherwise have to detect and
report at runtime. Enforcing them in the database makes the violating rows
_unstorable_, which converts a class of silent wrong answers into a loud write
failure at the point the bad data was produced.

`position >= 1` is the one that earns its keep: position 0 does not exist, and a
0 stored here renders _above_ position 1 on the inverted rank axis §11 requires
— better than first place. The mapper drops a sub-1 position to NULL and logs
it rather than letting the write fail.

All five are verified against a live Postgres 16, rejecting the bad rows and
accepting the legitimate ones.

## 11. Backfill progress is a new table, keyed per keyword

`gsc_backfill_cursors (keyword_id PK, property_id, covered_from, covered_through,
completed_at, updated_at)`.

Two designs were rejected:

**Derive progress from `gsc_snapshots`** (`MIN(gsc_date)` per keyword) needs no
new state, and is wrong. That table records only _positive_ observations —
Google omits dates with no impressions entirely — so a window in which a keyword
had no traffic writes no rows, `MIN(gsc_date)` does not advance, and the walk
either loops or redoes the same window forever.

**A single `properties.gsc_backfill_cursor`** is simpler, and leaves a keyword
added _after_ the property finished backfilling permanently blank: the property
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

| Pacific date                | Elapsed hours | Distinct `gsc_hour` labels   |
| --------------------------- | ------------- | ---------------------------- |
| 2026-03-08 (spring forward) | 23            | 23 — 02:00 never happens     |
| 2026-06-15 (ordinary)       | 24            | 24                           |
| 2026-11-01 (fall back)      | **25**        | **24** — 01:00 happens twice |

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
_literally_ out of the string rather than parsing it into a `Date` — a `Date`
round trip converts through the runtime's local zone and silently shifts the
hour, which is the class of bug domain rule 4 forbids.

---

# M2 — fixes from adversarial review

Thirteen defects, found by a five-dimension review and confirmed by reading the
code. Each is now covered by a regression test. The three that mattered most:

## 15. Date arithmetic was runtime-timezone dependent

`shiftDate` and `pacificDate` anchored at UTC midnight and then used date-fns
`addDays` — which operates in the **runtime's local timezone**. Adding a day to
a UTC-anchored instant still crosses whatever DST boundary the local zone
observes, shifting by an hour and landing on the previous UTC day.

The entire suite passed under `TZ=UTC` (the container, and Vercel) and failed
under `TZ=America/Los_Angeles`. Anyone developing on a US machine would have
computed the wrong Pacific dates — the exact class of bug domain rule 4 exists
to prevent, hidden by the one timezone CI happened to run in.

Replaced with `Date.UTC` plus a fixed millisecond offset: UTC has no DST, so a
day is always exactly 86,400,000 ms. `pnpm test:tz` runs the suite under
`America/Los_Angeles`, and it is also verified green under `Asia/Kolkata`,
`Pacific/Chatham` and `Australia/Lord_Howe`.

## 16. `rows_written` lost updates under concurrency

`tally.rows += await upsertGscSnapshots(...)` reads `tally.rows` **before**
suspending. With six keywords in flight, several read the same stale value and
all but one update is lost.

Mutation-tested: with the bug, a four-keyword run that writes 8 rows reports 2 —
a 75% undercount on the figure `/ops` uses to prove ingest is alive. Resolve
first, then add; no await between the read and the write.

## 17. An all-failed run was recorded as `partial`

`summarise` called `markPartial` per failure and nothing promoted the status, so
a run in which every keyword failed was indistinguishable from a degraded but
productive one — a warning on `/ops` where there should be a failure.
`aggregateStatus` existed for exactly this and was never called. Now it decides,
and `RunHandle.markFailed` records the outcome without throwing. The backfill
had the same shape and the same fix.

## The rest

| #   | Defect                                                                | Consequence                                                                |
| --- | --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 18  | Deactivating a keyword wedged the property's backfill                 | `keywordsRemaining` never reached 0; every later run did nothing           |
| 19  | A failing keyword re-attempted the same window at full speed          | A hot loop against Google for the whole 45s budget                         |
| 20  | The backfill budget was per property, not per invocation              | Ten properties asked for 450s inside a 60s function                        |
| 21  | The per-date hourly fallback discarded failed dates silently          | A partial day stored, run reported `success`                               |
| 22  | One keyword's 400 downgraded the whole property, racily               | 30 days on the slow path from an unrelated 400                             |
| 23  | `backfilled_at` was stamped for a property with no keywords           | A write-once lie that could never be corrected                             |
| 24  | Rows committed before a later failure were not counted                | Understated `rows_written`                                                 |
| 25  | Two divergent weighted-mean implementations                           | 7.7% of inputs differed by 0.01, surfacing as a revision Google never made |
| 26  | `getGscRevisions` ordered oldest-first while documenting newest-first | —                                                                          |
| 27  | `keywordsProcessed` counted windows, not keywords                     | —                                                                          |
| 28  | Retry-After was obeyed exactly, with no jitter                        | Every throttled caller retries at the same instant                         |

Two reported findings were **refuted** rather than fixed:

- **"`gsc_date` arrives as a JS Date on node-postgres."** It does not. The
  reviewer grepped `node-postgres/driver.js` and found no type parser, but
  drizzle installs a per-query `getTypeParser` in `node-postgres/session.js`.
  Measured against a live Postgres: the value is the string `'2026-09-08'` on
  both drivers, and the end-to-end read path resolves correctly. The projection
  through `to_char` and the runtime assertion in `resolveGscSeries` were kept
  anyway — the behaviour is a library detail the type system cannot check, and
  the failure it would cause is silent and total.

- **"`withRetry` should default to 4 attempts."** §12 says "3 retries"; §7 says
  "3 attempts". The default follows §7's more precise wording. `attempts` is a
  parameter for callers who want the other reading.

---

# M3 — DataForSEO ingestion

## 29. `checked_at` is the PROVIDER's timestamp, not our receipt time

`serp_checks` has `UNIQUE (keyword_target_id, checked_at)`, which only enforces
idempotency if `checked_at` is stable across redeliveries.

DataForSEO redelivers a pingback whenever the endpoint fails to return 200.
Stamping `now()` would make every redelivery a _new data point for the same
SERP_ — the rank would appear twice in the series, and the alert engine would
see movement that never happened. The provider's `datetime` field identifies the
SERP itself, so a redelivery collapses onto the same row.

`parseProviderDatetime` handles the `"2026-09-12 14:03:22 +00:00"` shape, which
`Date.parse` does not accept portably, and honours a non-UTC offset rather than
assuming UTC. Our receipt time is the fallback when the provider sends nothing.

## 30. The pingback route returns 200 on failure — deliberately

§6 says so, and the reason is worth stating plainly: DataForSEO retries a
non-200 pingback indefinitely, and each retry triggers another billed
`task_get`. A parse bug would therefore become a permanent redelivery loop that
also spends the balance.

Failures are recorded as a `failed` `ingest_runs` row instead, which is where
`/ops` looks. The only non-200 this route can return is **401**, for a caller
that failed the secret check — and that check runs before anything is fetched,
so an unauthenticated hit costs nothing.

## 31. Domain matching: subdomains count, lookalikes do not

§6 says "match on registrable hostname, ignoring `www.` and scheme — NOT
full-URL equality". Full-URL equality would only ever match the homepage.

Two decisions the spec leaves open:

- **Subdomains match.** An agency tracking `example.com` wants to know when
  `blog.example.com` outranks it. Treating it as a competitor would put the
  client's own site in their competitor table.
- **The leading dot is load-bearing.** `host.endsWith(own)` matches
  `notexample.com` against `example.com`; `host.endsWith('.' + own)` does not.
  Without it a competitor's rank is recorded as ours — a number that looks real
  and belongs to someone else. Both that case and the
  `example.com.evil.test` suffix trick are in the fixtures and the tests.

## 32. `task_post` does not retry connection failures

`withRetry` retries network-level errors by default, because for a read that is
exactly what retries are for. `task_post` and `live/advanced` opt out
(`retryNetworkErrors: false`): both bill on acceptance, so a connection reset
_after_ the server took the batch would double-charge on retry.

A 429 or 5xx is still retried — those mean the request was rejected, not
accepted.

## 33. A per-task failure inside a 200 envelope is still a failure

DataForSEO reports failure in three places: the HTTP status, the envelope
`status_code`, and each task's own `status_code`. All three can disagree — a
200 with envelope `20000` can carry a task that failed on a bad
`location_code`.

Counting those as submitted would make a keyword silently stop being tracked:
no error anywhere, just a series that quietly stops updating. `enqueueSerpBatch`
counts them as rejected and marks the run `partial`.

## 34. The live-check cooldown keys off live checks only

§10 rate-limits "check now" to 1 per 5 minutes per keyword. The obvious
implementation reads `keyword_targets.last_checked_at` — but that advances on
every _scheduled_ pingback too, so a routine check landing a minute earlier
would consume the user's manual allowance and the button would appear broken.

The cooldown is derived from the most recent check with
`provider = 'dataforseo-live'` instead. No new state: the distinction is already
in the column §4 gave us.

## 35. The setup checker uses the real client and the real parser

`pnpm verify:dataforseo --live` previously had its own fetch code and its own
inline domain matching. A setup checker with a second implementation can pass
while the real ingest fails, which is the opposite of its purpose. It now calls
`createDataForSeoClient` and `parseSerpResult`, so what it prints is what the
ingest would store.

## 36. DataForSEO fixtures are hand-written too

`src/test/fixtures/dataforseo/*.json` are built to DataForSEO's documented
advanced-SERP shape, not captured — no credentials exist in the build
environment. They model the cases §13 names, plus the two domain-matching traps
above. `pnpm verify:dataforseo --live` writes a real capture next to them.

The headline fixture deliberately reproduces the spec's own example: `rank_group`
7 but `rank_absolute` 13, with an AI Overview, a local pack, an images block,
People Also Ask and two ads above — a furniture gap of 6.

---

# M3 — fixes from adversarial review

Thirteen findings across three reviewers; the six that were adversarially
verified came back **0 refuted**. All thirteen are fixed and covered by
regression tests. The ones that mattered:

## 37. Nothing claimed a target on submission, so overlapping runs double-billed

`enqueueSerpBatch` selected due targets and then posted them. Two overlapping
cron invocations — a scheduler retrying after a 60-second kill, or any
at-least-once scheduler — both saw the same targets as due and both posted
them. At 400 tracked combinations that is **800 billed tasks instead of 400**,
every time it happens.

Worse, `last_checked_at` only advances when a _result_ lands. A target whose
pingback was lost (a failed task, a misconfigured webhook) stayed permanently
due and was re-submitted and re-billed on _every run, forever_, with nothing to
show for it.

`claimDueTargets` now selects and stamps `last_enqueued_at` in **one statement**
with `FOR UPDATE SKIP LOCKED`, returning only the rows this invocation won. Two
concurrent runs partition the work rather than duplicating it — verified
against a live database, not reasoned about. Selection is gated on
`last_enqueued_at` as well as `last_checked_at`, so an unhealthy target costs
exactly its intended cadence and no more. A claim on a _rejected_ task is
released, since nothing was spent on it; a claim on a _failed batch_ is held,
because a 502 or a reset can arrive after the provider accepted and billed it.

## 38. `task_post` retried 5xx, which can double-charge

The original comment claimed "a 429 or 5xx means rejected, not accepted". That
is true of 429 and **not** true of 5xx: a 502 from a gateway or a 504 timeout
can arrive after the backend took the batch. Retrying then pays for every task
twice with no second set of results.

`withRetry` now takes an `isRetryableStatus` override, and both billed-on-
acceptance calls narrow it to 429 only.

## 39. The live-check cooldown was a read-then-act race

Two simultaneous "check now" presses both read "no recent check" and both spent
$0.0020. There is no transaction to reach for — the Neon HTTP driver has none —
so the cooldown is now _claimed_ by a single conditional `UPDATE ... RETURNING`
on a dedicated `keyword_targets.last_live_check_at`. Postgres serialises the
row; three concurrent presses now yield exactly one billed call.

A consequence worth knowing: the cooldown is enforced against the **database**
clock, so it deliberately ignores an injected test clock. Tests age the stored
timestamp instead.

## 40. Concurrent redeliveries created duplicate payload rows

`recordSerpCheck` did `DELETE` then `INSERT` on `serp_payloads` with no
transaction. Two concurrent redeliveries of the same task both found nothing to
delete and both inserted. A `UNIQUE (serp_check_id)` constraint plus an upsert
makes that unrepresentable rather than merely unlikely.

## 41. An out-of-order pingback rewound `last_checked_at`

Two tasks for one keyword can be in flight and complete out of order. Writing
`last_checked_at` unconditionally let the older result rewind it past the check
interval, making the target look due again — a slow loop of re-submitting and
re-paying for a keyword that was perfectly up to date. The update is now
guarded to advance only forward.

## 42. `inserted` was a 60-second clock heuristic

It compared `created_at` against a one-minute window, so a redelivery arriving
20 seconds after the original reported a fresh insert. M7's alert engine keys
duplicate suppression off this flag and would have fired a second "you dropped
5 positions" alert for the same SERP.

Now `RETURNING (xmax = 0)` — Postgres's own answer to "was this an INSERT or an
UPDATE".

## 43. `--live` saved the PARSED envelope as the "real shape" fixture

The whole point of capturing a real response is to record the fields our schemas
_don't_ model. Writing `JSON.stringify(envelope)` wrote the parser's projection
of the response — a fixture that can never falsify the schema, because
re-parsing it is guaranteed to succeed.

Measured on the committed fixture, the round trip lost envelope
`version`/`time`/`tasks_count`/`tasks_error`, task `time`/`result_count`/`path`,
and result `type`/`se_domain`/`check_url`/`spell`/`refinement_chips`/
`item_types`. The script now tees the raw body through a wrapping `fetchImpl`
and writes those bytes, and reports how many fields our schemas strip.

## 44. An internationalised domain could never match its own results

`new URL()` punycodes hostnames, so a property stored as Unicode compared
`xn--r8jz45g.jp` against `例え.jp` and never matched. The site could rank #1 and
be recorded as `found = false` with NULL ranks — indistinguishable from being
absent from the top 100. Both sides now normalise through `URL`.

## 45. An all-rejected batch was recorded as `partial`

Same class as NOTES.md §17, in a place I had not applied it: DataForSEO down,
balance at zero, credentials rotated — a yellow row on `/ops` where there should
be a red one, while rank data silently stops arriving for every keyword.

---

# M4 — cron, retention and ops

## 46. `/ops` fails CLOSED in production until M5

§10 makes `/ops` agency_admin only and it exposes ingest errors and spend.
Auth.js lands in M5, so `checkOpsAccess()` is the seam that will hold the real
session check — and until then it refuses to render in production. Shipping it
open with a promise to lock it down next milestone is how an internal dashboard
ends up indexed; a page that refuses is the obvious failure mode to prefer.

## 47. Retention rolls up FIRST, and refuses to delete an unrolled day

Order is the whole design. `pruneSerpChecks` deletes only rows whose day already
has a rollup — so if the rollup job has been failing silently for a fortnight,
nothing is destroyed; deletion simply defers.

The pre-prune rollup deliberately has **no lower bound**. An earlier version
used `CHECK_RETENTION_DAYS + 7`, which created a window of rows too old to be
rolled up and therefore — because of the guard above — impossible to delete
either. They accumulated forever, which is the opposite of the job's purpose.
Caught by a test asserting a two-year-old check still gets removed, and
mutation-tested to confirm the test fails when the bound returns.

`pruneGscHourly` has the mirror guard: hourly rows are dropped only for dates
that already carry a `final` row. Without it, a date whose reconciliation never
ran would lose everything and render as a permanent gap that looks like "no
impressions".

## 48. Rollup days are cut in the PROPERTY's timezone

`checked_at` is a timestamptz and a day has to be cut somewhere. The property
timezone is the only defensible choice: "moved today" has to mean what the
client means by today, and grouping a Noida property's checks by UTC would split
every Indian evening across two rollup rows.

This is _not_ the Pacific-date rule from domain rule 4 — that governs Search
Console dates, which Google assigns. These are our own timestamps.

Not-found checks count toward `checks_count` but not `found_count`, and are
excluded from every rank aggregate. Postgres MIN/MAX/AVG skip NULLs, so a day of
pure misses yields NULL ranks rather than an invented position.

## 49. Raw `db.execute` returns timestamps as STRINGS

Unlike the typed `select()` path, which runs drizzle's column mapper, a raw SQL
result hands back whatever the driver produced — and the declared row type is a
promise the query cannot keep. `recentIngestRuns` and `ingestHealth` both
declared `Date` and got strings; calling `.getTime()` on one threw
`date.getTime is not a function`, which on `/ops` is a 500 rather than a
dashboard.

The same class as the numeric-as-string trap from M2, in a different code path.
Parsed once now, in `toDate`, with tests asserting the returned values really
are `Date` instances. The page was rendered against real data to confirm it.

## 50. One Vercel cron entry, three daily jobs

`vercel.json` registers only `/api/cron/daily`, which chains reconcile → rollup
→ prune. Hobby's cron allowance is small and has varied between plan revisions;
one entry is safe under any of them. Each step stays individually addressable
for the external scheduler and for manual re-runs.

The hourly work comes from `.github/workflows/ingest.yml` (requirements.md §9,
Option C). It has a `concurrency` group: every job is idempotent, but two
concurrent SERP batches would claim disjoint target sets and double the hourly
spend.

A failed cron returns **500**, so the scheduler's own alerting sees it. That is
the opposite of the pingback route, where a non-200 makes DataForSEO redeliver
forever — a scheduler retrying a cron is harmless.

---

# M5 — auth and tenancy

## 51. Property grants are resolved from the DATABASE, not from the token

§10 says to "put `role` and the permitted `property_id` list in the session
token". The role and organisation are there; the property list is not.

A token is issued at login and lives for its whole lifetime. Putting grants in
it means revoking a client's access takes effect only at their _next_ login —
so removing someone from an account leaves them reading it for hours. One
indexed query per check is worth not having that window. It also keeps the
cookie a fixed size regardless of how many properties an agency manages.

## 52. Organisation is checked before role, for every role

`canAccessProperty` checks that the property belongs to the principal's
organisation _first_, and that check applies to `agency_admin` too. An admin is
an admin of their own agency, not of the database. There is a test asserting
org A's admin cannot read org B's property.

A `client` additionally needs an explicit `user_properties` grant, and a client
with **no** grants sees nothing — fail-closed, so a half-provisioned account
leaks nothing.

## 53. A missing resource returns 403, never 404

`assertKeywordAccess` raises `ForbiddenError` both for a keyword in another
tenant and for one that does not exist. A 404 for the latter would confirm which
ids exist, turning every id-addressed route into a cross-tenant enumeration
oracle. The same rule applies to `forProperty`.

## 54. `forProperty` enforces by construction, not by convention

§10 asks that "writing an unscoped query is structurally difficult rather than
merely discouraged". The structural part is that `forProperty` is **async and
performs the access check before it returns** — there is no way to obtain a
scope for a property you cannot read, so a route holding a `PropertyScope` has
already passed tenancy. The check cannot be forgotten because it is what
produced the object.

Every builder pre-applies `property_id = <scope>` and a caller's extra predicate
is **AND**ed, not substituted. There is a test asserting that asking a scope for
another tenant's keyword by id returns nothing — a `.where()` that replaced the
scope would silently undo the entire model.

`daily_rank_rollups` has no `property_id` of its own, so its builder joins
through `keyword_targets`. That is the one table where an unscoped query looks
perfectly normal.

Backed by a guard test: no file under `src/app` may import the raw `db` handle,
except the machine-authenticated endpoints (`api/cron`, `api/webhooks`,
`api/health`, `api/auth`), which hold no session and legitimately operate across
tenants. Mutation-tested.

## 55. Middleware guards PAGES only — never `/api`

The first version matched `/api` too, and an anonymous `GET /api/properties`
came back as a **307 to an HTML login page** instead of the typed
`{"error":{"code":"UNAUTHORIZED"}}` §10 specifies. A `fetch` that follows
redirects would have received a 200 full of markup, which looks like success.

Found by actually driving the flow with curl rather than by reading the code.

The middleware is also _not_ the security boundary, and says so: it checks only
that a session cookie is **present**, without verifying its signature. It runs
on the edge runtime, where the database is unreachable — treating it as the
boundary would put the real checks somewhere that cannot perform them. Every
page and route re-resolves the principal server-side.

## 56. Password logic lives outside the Auth.js wiring

`config.ts` imports `next-auth`, which pulls in Next's server runtime and cannot
be loaded under vitest. Hashing, normalisation and verification therefore live
in `credentials.ts`, which is the part worth testing.

Three properties covered by tests: the stored hash is bcrypt at **cost 12**
(asserted against the `$2b$12$` prefix of a real row); the email is trimmed and
lowercased, so casing cannot lock a user out; and an unknown address still runs
a full bcrypt comparison against a decoy hash.

That last one matters: without it, "no such user" returns in microseconds while
a real user costs a full cost-12 verification — a reliable oracle for
enumerating which addresses have accounts. The decoy is generated at module load
at `BCRYPT_COST` rather than hard-coded, so it cannot drift from the real cost.
The login form shows one message for every failure, for the same reason.

## 57. Session tokens are shape-validated on the way out

The JWT is signed by us, so this is not about forgery — it is about **staleness**.
A token issued before a schema change (a role renamed, a claim added) is
cryptographically valid and semantically wrong, and reading a missing claim as
`undefined` would hand `role: undefined` to the access checks. The session
callback parses the claims with Zod and blanks the identity if they do not fit,
which logs the holder out rather than admitting them with an undefined role.

## 58. `/ops` is agency_admin only — including against agency_member

The M4 placeholder gate (closed in production, open in development) is replaced
by the real role check. `/ops` shows ingest errors, per-property freshness and
spend across the whole organisation, so it is the one page an `agency_member`
should not see either. Verified end to end: the seeded client account gets
"restricted to agency administrators"; the admin account gets the dashboard.

---

## M6 — dashboard

### 56. The two series share a time axis, not a day axis

The obvious dashboard chart puts a day on the x axis and three values on it.
That cannot be built honestly here.

`gsc_snapshots.gsc_date` is a **Pacific** calendar day, assigned by Google and
never shifted (domain rule 4). `daily_rank_rollups.day` buckets `checked_at` by
the **property's** timezone, because "moved today" has to mean what the client
means by today (see §? / `src/server/ops/rollups.ts`). Asia/Kolkata is UTC+5:30
and Pacific is UTC−7/−8, so the two grids are 12.5–13.5 hours apart. A chart
with one "day" axis silently asserts they are the same day.

So the chart takes **two arrays** on a shared numeric time axis:

- live checks at their true `checked_at`;
- Search Console days anchored at **midday of their own Pacific date** — the
  same anchor `getReconciliation` uses, and a defensible centre for a figure
  that describes a whole day.

Recharts supports per-`<Line data={...}>` arrays against a numeric axis, which
is what makes this possible while keeping `connectNulls={false}` meaningful:
each series' nulls are its own genuine gaps, not an artefact of the other
series having a point at a timestamp this one does not.

Merging into one array and setting `connectNulls={true}` on the GSC line would
bridge the check-only timestamps — and would also bridge genuinely missing GSC
days, which is exactly what acceptance criterion 3 forbids.

### 57. `Intl.DateTimeFormat` without a `timeZone` formats in the runtime zone

`formatGscDate` built a UTC-midnight `Date` from a `YYYY-MM-DD` string and
formatted it with no `timeZone` option. `Intl` then used the _runtime_ zone, so
on any host behind UTC the date rendered a day early — every Search Console date
on the dashboard, off by one.

The suite passed under UTC (Vercel's default, and the container's). `pnpm
test:tz` caught it immediately. This is the same class as the `date-fns addDays`
bug in §? and the same lesson: any date arithmetic or formatting that does not
name its timezone is reading the machine's.

Fixed with `timeZone: 'UTC'` on the formatter — the instant is UTC midnight, so
formatting it in UTC always yields the intended calendar day. The suite now runs
green under UTC, America/Los_Angeles and Asia/Kolkata.

`formatGscDate` also threw on a malformed string: `Number('a')` is `NaN`, not
`undefined`, so the `=== undefined` guard passed it through to `Intl`, which
throws on an invalid time value — taking down a whole page render over one bad
row. Guarded with `Number.isFinite`.

### 58. A second implementation of the precedence rule had crept in

`keywordRows` carried an `impressions` CTE that re-derived "latest daily row,
final > fresh > hourly" in SQL to fetch an impression count. §5 says that rule
lives in exactly one function, and it does — `resolveGscSeries`. The CTE was a
second definition that happened to agree.

It would not have kept agreeing: the resolver does impression-weighted hourly
aggregation, so the moment a keyword's freshest reading was an hourly aggregate,
the table and the chart would have shown different numbers for the same keyword
and both would have looked right.

Removed. `keywordRows` now makes a second round trip through
`getGscSeriesForKeywords` and attaches the reading in JS. One extra query; one
definition of the rule.

### 59. Dropping out of the top 100 is not a ranking-URL change

`rankingUrlChanges` compared `rankingUrl` between consecutive checks. A
not-found check has `ranking_url = NULL`, so a keyword that fell out of the top
100 and came back on the same page produced two entries: `url → none` and
`none → url`.

Both are lies. Losing the ranking entirely is a different event with a different
cause, already visible in the chart's not-found band and in the rank column. The
event this list exists to surface — domain rule 7, Google quietly preferring a
different page of yours at an unchanged position — was buried under it.

Not-found checks are now skipped rather than treated as a transition to no URL,
so a genuine swap that happened _across_ a not-found stretch is still reported,
with both real ends. Mutation-tested: removing the skip fails three tests.

### 60. Dark mode existed but nothing turned it on

`globals.css` shipped a complete `.dark` token set from M1 and
`@custom-variant dark (&:is(.dark *))`. Nothing ever added the class, so the
dark palette was unreachable — `prefers-color-scheme: dark` did nothing, and the
`dark:` utilities scattered through the components were dead code.

Two fixes. The variant was `&:is(.dark *)`, which matches descendants of `.dark`
but not `.dark` itself; it is now `&:where(.dark, .dark *)`. And a blocking
script in `<head>` stamps the class from `localStorage` or the OS preference
before first paint — deciding it in React means rendering light, hydrating, then
flipping, which is a white flash on every navigation for a dark-mode user.

### 61. The palette is computed, not chosen

The three series colours were hand-picked OKLCH values. They are now the
validated categorical slots 1–3 from the data-viz reference palette, checked
with its validator at `--pairs all` in both modes:

|                             | light | dark |
| --------------------------- | ----- | ---- |
| worst-pair CVD ΔE           | 9.2   | 9.4  |
| worst-pair normal-vision ΔE | 24.0  | 20.9 |

Aqua (`rank_absolute`) sits at 2.74:1 against the light surface, below the 3:1
line. The relief rule applies and is satisfied deliberately: every
`rank_absolute` value also appears as text in the tooltip, in the table, and in
the reconciliation prose, so the colour never carries the number alone.

Dark is a separately stepped set, not an inversion of light.

---

## M7 — alerts

### 62. The signature bucket is never a date

§9 specifies `sha256(type + keyword_target_id + bucket)` and a partial unique
index on `signature WHERE resolved_at IS NULL`. The index handles "do not
duplicate an open alert"; the bucket decides what counts as the SAME alert.

A date is the obvious bucket and the wrong one: it makes a condition that
persists for a fortnight raise fourteen alerts, one a day, which is how an
alerting system becomes something people filter to a folder.

What each bucket actually is:

| kind                                                       | bucket                   | why                                                                                     |
| ---------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------- |
| state (`lost_top_10`, `entered_top_10`, `lost_from_index`) | empty                    | there is one way to be in that state                                                    |
| move (`rank_drop`, `rank_gain`)                            | the position moved FROM  | 5 → 15 and a later 15 → 40 are two problems; re-detecting the same 5 → 15 hourly is one |
| event (`ranking_url_changed`, `new_competitor_top_3`)      | the new URL / the domain | the thing that happened IS the identity                                                 |

This makes resolution load-bearing rather than cosmetic. An open alert holds
its signature, so an engine that only ever opened alerts would fire each
condition exactly once and never again. Both the engine (condition cleared) and
a person (dealt with it) can close one.

### 63. An older re-run must not resolve a newer alert

Found by running the engine over demo data out of order.

Evaluating 2026-09-10 after 2026-09-12 resolved the alerts 09-12 had raised —
the condition did not hold on the older day, so the engine dutifully closed
them. That freed their signatures, and the next forward run raised every
ongoing condition again as if it were new. Backfilling a week would have
re-notified the lot.

`created_at` cannot fix this: it records when the job RAN, not which day's data
it read, and those differ on exactly the runs that trigger the bug. So every
candidate carries `payload.day`, and resolution is gated on
`(payload->>'day')::date <= <day being evaluated>`.

Covered by an integration test that runs a newer day, then an older one, and
asserts nothing was resolved. Removing the guard fails it.

### 64. A rollup built from one check IS that check

§9: "Baselines come from `daily_rank_rollups`, using `best_rank_group`, never a
single check." It is tempting to read that as satisfied by reading a rollup.
It is not — `best_rank_group` over a one-check day is that check's rank, and
`found_count = 0` over a one-check day is one flaky miss.

Two places this bites in practice: the day a property is onboarded, and the
current day before its second check of the day. Both would have raised a
critical "no longer in the results" from a single miss.

So the gate is on `checks_count`, not on the existence of a rollup row, and it
covers RESOLVING as well as raising: a day we cannot judge is not evidence that
a condition cleared, and auto-resolving on one frees the signature — turning
one ongoing problem into a fresh notification every time a thin day comes
round.

### 65. The anti-pattern guard caught my own routes

Both new alert routes imported the raw `db` handle, and `env-boundary.test.ts`
failed the build for it. The guard was right: the writes were scoped by
convention (`eq(alerts.propertyId, scope.propertyId)` written out by hand at
each call site) rather than structurally.

Alert mutations now live on the scope object next to the reads —
`markAlertRead`, `resolveAlert`, `markAllAlertsRead` — so the property
predicate is applied by the thing that performed the tenancy check, and
`assertAlertAccess` resolves the owning property in the same step that checks
it. A route can no longer forget either half.

### 66. A truncated request body is a 400, not a 500

`request.json()` throws a `SyntaxError` on an empty or truncated body, which
reached the catch-all in `handleRoute` and was logged as an unhandled server
error.

It is not one, and it happens without an attacker: a `fetch` aborted by a
navigation arrives with its headers and no body. Observed for real while
driving the alerts page — a mark-all click during an in-flight refresh.

`readJson()` now turns it into a typed 400, so a malformed request stops
looking like a server fault in the logs.

---

## M8 — hardening

### 67. `open(p,'w')` truncates before `open(p).read()` runs

Prepending a comment to a generated migration with

```python
open(p, 'w').write(header + open(p).read())
```

leaves the file containing only the header. Python evaluates the argument after
opening for write, and opening for write truncates.

The result was a migration file with its explanatory comment and no
`CREATE TABLE`. `drizzle-kit migrate` ran it, reported success, recorded it as
applied — and the table did not exist. `drizzle-kit generate` on the next
machine would have produced it again.

**A migration recorded as applied that did nothing is worse than one that
failed.** The failure is loud and local; this one is silent and travels.

Two guards now, in `migrations.integration.test.ts`:

- every journal entry's `.sql` file must contain SQL once comments are
  stripped;
- every table declared in `schema.ts` must exist after the migrations run.

Both mutation-tested. The second also catches the opposite drift — a migration
that creates something `schema.ts` never declared, or a rename on one side only.

### 68. `/api/health` was lying about the schema

The health endpoint held a hand-written list of expected tables. Two
milestones added tables and the list did not, so the endpoint reported
`"migrated": true, "tablesPresent": 12, "tablesExpected": 12` against a database
missing both of them.

A health check that lies about the schema is worse than not having one: it is
the thing you trust at 2am to tell you whether the deploy landed.

The list is derived from `schema.ts` now, the same way §67's guard is, so it
cannot fall behind.

### 69. Retries were invisible

`withRetry` accepted a `label` and dropped it; `onRetry` had no production
consumer. Nothing anywhere recorded that a call had been retried — and retry
pressure is the earliest signal that a provider is degrading, long before a job
fails.

The DataForSEO client was even passing `label: path`, so the intent was there
and the wiring was not. `withRetry` now logs a structured `warn` through the
existing (redacting) logger, and `label` reaches `onRetry` too.

### 70. The 403 page was unreachable in production

`error.tsx` decided whether to show "No access to this property" by checking
`error.message`. In production Next REPLACES a server error's message with a
generic string before the boundary sees it — deliberately, so a stack trace or
a connection string cannot reach the browser.

So the branch could never be taken in production. A client opening a stale
bookmark saw "Something went wrong" and a reference number instead of the one
sentence that would have told them what to do. It worked perfectly in
development, which is exactly why nothing caught it until an end-to-end test ran
against a production build.

`ForbiddenError` now carries a `digest`, which Next preserves, and the boundary
matches on that.

**And the fix broke the build**, informatively: `error.tsx` is a client
component, so importing the constant from `server/auth/access` pulled `pg` into
the browser bundle. A constant shared between server and client has to live
somewhere with no server dependencies — `src/lib/error-digests.ts`.

### 71. Two `<main>` landmarks during a streaming handoff

`loading.tsx` rendered a `<main>`, and so does every page. Next streams, so
during a navigation both are in the document at once — a document with two main
landmarks, which to a screen reader is a document with no main content.

Found because Playwright's strict mode refused to guess which `<main>` a
selector meant. The skeleton is a `<div role="status">` now.

The related test lesson: the keyword list is server-rendered TWICE (a card list
for phones, a table above `sm`, toggled with CSS so there is no layout shift and
no client-side branch), so `.first()` resolves to whichever is hidden at the
current width. The specs filter to `visible: true`, which is also what the
assertions actually mean.

### 72. `AUTH_URL` must match the served origin exactly

A production server on `:3100` with `AUTH_URL` pointing at `:3000` signs the
user in successfully and then redirects them to a port nothing is listening on.
The browser reports `ERR_CONNECTION_REFUSED` **after** a valid login, which
reads as a broken application rather than a configuration mismatch.

`playwright.config.ts` sets `AUTH_URL` and `APP_BASE_URL` for the server it
starts, so `pnpm test:e2e` works whatever `.env.local` says. requirements.md
§11 already says "must match exactly"; this is what that sentence costs when it
is not followed.

### 73. Rate limits belong in a table, not in memory

An in-memory counter in a serverless deployment enforces the limit PER
INSTANCE. The effective ceiling is the configured limit multiplied by however
many instances happen to be warm — so it weakens exactly as load increases,
which is when it matters.

`api_rate_limits` holds one row per (principal, bucket) and the window start
MOVES rather than rows accumulating, so the table is proportional to active
callers rather than to requests. The check is a single upsert that both resets
an expired window and increments a live one: a read-then-write would let a
burst of N through the moment two requests interleave, and interleaving is the
normal case under the load a limit exists for. Verified with ten concurrent
calls against a limit of four.

It fails OPEN. A rate limiter that takes the API down with it has turned a
throttle into an outage.

This is deliberately NOT how the "check now" cooldown works. That one guards
SPENDING and must be exactly once per five minutes per target, so it is claimed
with a conditional UPDATE on the target row. This one guards effort, and a
fixed window is the right shape for it.

### 74. A layout's error goes to the PARENT segment's boundary

The property-scoped error boundary at `app/p/[propertyId]/error.tsx` exists
mainly for one case: someone opens a bookmark for a property they no longer have
access to, and should read "no access to this property" rather than "something
went wrong".

It never ran for that case. The tenancy check lives in the property LAYOUT, and
in the App Router **an error thrown in a layout is caught by the parent
segment's boundary, not its own** — a layout cannot catch its own failure,
because the boundary it would use is inside the tree that failed to render.

So every 403 landed in the root `app/error.tsx`, which knew nothing about
forbidden and rendered the generic apology. Both boundaries now render one
shared `ErrorView`, which knows the difference.

This is not visible in the code. Nothing about `error.tsx` sitting next to
`layout.tsx` suggests it will not catch it. An end-to-end test against a
production build found it in one assertion.

### 75. Two test-harness lessons worth keeping

**`toBeVisible` is wrong for an SVG `<g>`.** A group element has no box of its
own, so Playwright reports it hidden even while its children are painted. For
"the axis has rendered", poll the tick COUNT.

**Do not click through a list that is rendered twice.** The keyword list is
server-rendered as both a phone card list and a table, toggled with CSS so there
is no layout shift and no client-side branch. A `.first()` click lands on
whichever is hidden. Filtering to `visible: true` fixes the selector; for a
setup hook the better answer is to read the href and navigate, because the
anchor is not what the test is about and the click was the flakiest step in the
suite.

---

## Post-M8 — what a 14-dimension adversarial audit found

183 agents: 14 finders, three independent skeptics per finding, a completeness
critic. 56 candidates, **33 confirmed, 23 refuted**. The refutations mattered as
much as the findings — six things that looked like serious defects were not, and
are recorded at the end so nobody re-reports them.

### 76. The two day grids, a third time

§56 established that a Pacific day and a property day are different grids and
that the CHART must not conflate them. The dashboard QUERIES then did exactly
that: `keywordRows` and `rankSparkline` computed their rollup baselines with
`pacificToday()`, and `daily_rank_rollups.day` is bucketed in the property's
timezone.

For the 12.5–13.5 hours a day the grids disagree — the entire Indian working
morning, which is when this dashboard is read — every Δ indexed one rollup day
too far back. Reproduced at 12:09 IST against the demo database: latest check
#5, the property's real yesterday-best #4, so the keyword had got WORSE by one;
the table rendered a green "↑ improved by 1".

Three independent finders reached this from different dimensions (dates,
sentinels, dashboard-sql) and all nine verifiers confirmed it at `high`.

The lesson is that a comment is not a mechanism. §56 wrote the rule down and the
next author — the same author — broke it four files away. There is now a
`src/lib/property-dates.ts` whose only export is `propertyToday()`, deliberately
NOT in `gsc-dates.ts`, so using the wrong grid requires importing from the wrong
module.

### 77. The Δ column compared a point against an aggregate

Separately, and in the same expression: the delta was `latest single check −
MIN(best_rank_group) of the baseline day`. A live instant against a daily
minimum. Whenever the day's best check was better than the moment you looked, it
reported an improvement that had not happened.

The function's own doc comment said a Δ column disagreeing with the alert
engine's baseline "would be worse than no Δ column" — and then it disagreed.
Both ends are rollup values now, gated on the alert engine's own minimum check
count. The rank column is still the live check, because that is the product; the
Δ column is explicitly best-of-today against best-of-that-day.

Consequence worth knowing: on a young day, before a target's second check, every
Δ is null. That is honest and matches the engine, which also declines to judge
a one-check day.

### 78. `??` does not catch a provider zero

DataForSEO bills at `task_post` and serves results free for thirty days, so
`task_get` answers `"cost": 0`. Not null — zero. `task.cost ?? null` therefore
stored `0.000000` on every scheduled check, and `/ops` — the page whose entire
job is "you are spending real money on a schedule; watch it" — reported **$0.00
month to date** while the account was billed for all of it.

The live "check now" path had a fallback (`task.cost ?? COST_PER_SERP.live`) and
was always right, which is why the bug was invisible: the only non-zero number
on the page came from the one path that is used by hand.

The repo could not catch it either. The integration test asserts 0.0006 is
stored, but the fixture it feeds to `task_get` is a LIVE response carrying a real
cost. The repository's only genuine `task_get` fixture, `task-get-error.json`,
has `"cost": 0` — the accurate shape was already in the tree.

### 79. A half-deleted day silently corrupted the archive

`pruneSerpChecks` cut at an instant: `checked_at < now() - 90 days`. On the
boundary day that deletes the checks before that instant and keeps the rest.

Harmless alone. Fatal in combination with the pre-prune rollup, which is
deliberately unbounded (§47) and recomputes every day from whatever checks still
exist: the next run recomputed that day from the surviving half and
`ON CONFLICT DO UPDATE` overwrote a correct full-day rollup with a partial-day
aggregate. Permanently, and to the archive whose entire purpose is to outlive the
per-check rows.

Two individually-correct decisions — "cut at an instant" and "roll up
unboundedly" — combining into data loss. Deletion is now aligned to the same
property-timezone day the rollup uses, so a day is deleted whole or not at all.

### 80. "Check now" returned the failing SQL to the client

Its catch block spans the database write as well as the provider call, so a
driver error — carrying the failing statement and its bound parameter values —
was returned verbatim in the 502 body to any authenticated user, including a
client-role one. Acceptance criterion 12.

`redactError` strips credentials, connection strings and PEM blocks. It does not
strip a query, and the route's own comment asserted a guarantee the function
never made: "it never carries credentials". The provider's status lines are
returned where they are known to BE status lines; everything else is logged and
the caller gets a constant.

### 81. Absence of evidence rendered as evidence of absence

The reconciliation panel showed a critical "not found" badge for targets that
had simply never been checked near the date. `getReconciliation` LEFT JOINs
`serp_checks`, and `found: row.found ?? false` collapsed three states into two.

So whenever SERP ingest paused while Search Console kept flowing — balance
exhausted, credentials rotated, a new target before its first pingback, all
cases the runbook has sections for — the panel told the client their keyword had
vanished from Google. `SerpSide.found` is `boolean | null` now.

### 82. `\b` does not do what it looks like it does before an underscore

`redact()`'s secret-pair pattern was anchored with `\b`, which requires a
NON-WORD character before the keyword. `_` is a word character. So
`access_token=`, `client_secret=` and `CRON_SECRET=` — the most common real
spellings of the thing the pattern exists to catch — all failed to match. Only a
bare `token=` was ever redacted.

Tested by running the function rather than by reading the regex, which is the
only way this class of bug is ever found.

### 83. The alert type that nothing produced

`ingest_failure` was in the schema enum and labelled in the alerts UI, and no
code path anywhere created one. The single failure mode the system is least able
to notice — a job that stops running raises no error, it produces an absence —
was the one with no alert.

Now raised per property, per source, when data that once flowed has stopped:
36 hours for Search Console, 24 for live checks. Deliberately requires that data
once flowed, because a property added an hour ago has no rows and is not broken;
that case is `/ops`'s "never produced a row", which is where the runbook already
sends you.

### 84. Two tests that had quietly stopped testing

**A test that expired.** `dueTargets` compares against the DATABASE clock while
the test pinned `last_checked_at` to a fixed 2026-09-12. It passed for as long as
the real clock stayed within the check interval of that date, and was already
failing on HEAD by the time the audit ran. The instant is injectable now.

**A mock armed after the call.** The cron dispatcher's only `durationMs`
assertion set its mock on the line AFTER the request, so the request ran against
the default mock, took the crash path, and asserted a field present on both
shapes. The success path it was named for had never executed.

### 85. Refuted — do not re-report these

Six findings that looked serious and were not. Each was killed by a skeptic that
went and checked:

- **`/ops` is not organisation-scoped.** True, and unreachable: nothing in the
  product can create a second organisation. No signup, no org-creation route, no
  admin UI; the only insert is the seed's single fixed row. Latent, not live.
- **Role and org are never re-read after sign-in.** That is the specified
  design (requirements.md §462-463) and §51 already records the one place this
  build deliberately deviated from it. A documented decision, not a defect.
- **Move alerts are never auto-resolved.** The mechanism was real and is now
  fixed for a different reason (§86 below), but the claimed consequence — that a
  later larger collapse would be silenced — does not hold.
- **The engine only evaluates the in-progress day, silencing the property.** The
  alerts job runs HOURLY, not daily, so the in-progress day is re-judged every
  hour from the moment a target's second check lands. (I had repeated this one
  to the user as a correction of my own M7 reasoning. The refutation is right and
  my original reading was right: the gate fires on thin days and the hourly
  cadence covers the rest.)
- **`lost_top_10` is resolved off the day's BEST rank, so it flaps.** Raise and
  resolve read the same metric and are exact complements. "Best rank_group wins"
  is domain rule 8, not an asymmetry.
- **Deactivating a keyword strands its alerts.** No route, mutation or UI
  control deactivates anything; it takes a DBA running UPDATE by hand.

### 86. Hysteresis: the fix that needed a second fix

`rank_drop`/`rank_gain` bucketed their signature on the position moved FROM, so
that 5 → 15 and a later 15 → 40 would be two alerts. But the baseline is a
SEVEN-DAY SLIDING window — it advances daily — so for any trending keyword the
"from" value changes every day and the signature changed with it. One steady
climb in the demo data raised on **22 consecutive days across 18 buckets**.

Making the move an episode (bucket `''`, resolved when it stops holding) cut
that to six. Six, not one, because a matched raise/clear pair at the same
threshold flaps: the gap oscillated between 3 and 6 around a threshold of 5 and
the episode opened and closed on alternate days.

Clearing at a strictly lower bar than raising — `RANK_MOVE_CLEAR_THRESHOLD = 3`
against a raise at 5 — makes it one alert, opened when the climb started and
closed when it flattened. Walking the engine forward 22 days over the demo data:
22 alerts for one target became 2 at worst.

The general lesson: any threshold that both opens and closes a state needs two
thresholds, or it will chatter at exactly the value that matters most.
