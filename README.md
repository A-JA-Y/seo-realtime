# Rank Tracker

Near-realtime Google rank tracking for a multi-property SEO agency. Ingests
**Search Console average position** and **DataForSEO true rank** side by side,
keeps them rigorously separate, and makes the gap between them an explainable
feature rather than a support ticket.

> **Setup first.** [`requirements.md`](./requirements.md) provisions every
> account and credential this needs, with a verification step after each one.
> Deliberate deviations from the build spec are recorded in
> [`NOTES.md`](./NOTES.md).

---

## The one thing to understand

Three numbers, routinely confused:

| Number               | What it measures                                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rank_group`         | Which blue link you are. Organic results only.                                                                                                           |
| `rank_absolute`      | How far down the page you are. Counts every SERP element — AI Overview, local pack, images, People Also Ask, ads.                                        |
| GSC average position | A click-weighted **mean** over every impression in a window, across all devices and locations. Continuous, provisional for days, revised after the fact. |

`rank_absolute` is what reconciles with Search Console, because Google counts
those blocks too. `rank_group` is what a human gets counting down the page. The
difference between them is the **SERP furniture penalty**.

Averaging a Search Console position with a DataForSEO rank produces a number
that measures nothing. The schema enforces the separation; every number in the
UI is labelled with its source.

---

## Status

| Milestone                         | State                                                                                                                                                                                                                                                                                                |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M1 — Foundation**               | **Complete.** Next.js 15 + strict TS + Tailwind v4, Zod env validation, full Drizzle schema + migration, idempotent seed, health route, setup verification scripts                                                                                                                                   |
| **M2 — Search Console ingestion** | **Complete against fixtures.** JWT auth, hourly job with the documented dimension fallback, `fresh` + `final` writers, resumable 16-month backfill, the single read-precedence function, retry policy, structured logging, `ingest_runs`. **Not yet verified against the live property** — see below |
| **M3 — DataForSEO ingestion**     | **Complete against fixtures.** Batched `task_post`, secret-guarded pingback webhook, the parser, trimmed payload storage, live "check now" with its cooldown. **No live SERP has been fetched** — see below                                                                                          |
| **M4 — Cron + ops**               | **Complete.** Authenticated cron dispatcher, retention with rollup-first safety guards, daily rank rollups, `/ops` page, GitHub Actions hourly schedule. `/ops` fails closed in production until M5 brings auth                                                                                      |
| **M5 — Auth + tenancy**           | **Complete.** Auth.js credentials, three roles, `assertPropertyAccess`, the `forProperty` scoped builder, cross-tenant tests at the API layer, `/ops` gated to agency_admin                                                                                                                          |
| **M6 — Dashboard**                | **Complete.** Property picker, overview tiles, keyword table, keyword detail with the dual-series chart and the reconciliation panel, competitors, SERP composition strip, ranking-URL history, "check now", dark mode. Verified against 28 days of synthetic data and eyeballed at 1400px and 400px |
| **M7 — Alerts**                   | **Complete.** Eight alert types, pure rules, signature-based suppression, automatic and manual resolution, and the in-app feed with mark-read / resolve / mark-all. Its own cron job, chained after the rollup                                                                                       |
| M8 — Hardening                    | Not started                                                                                                                                                                                                                                                                                          |

Pacific-time date handling (`src/lib/gsc-dates.ts`) landed early — the setup
checker needs it, and it encodes domain rule 4.

### Picking this up

Everything below is the state of play for whoever continues, written so you do
not have to reconstruct it from the diff.

**What M6 built.**

- `src/server/dashboard/queries.ts` — keyword rows with deltas from
  `daily_rank_rollups.best_rank_group` (a missing baseline is NULL, never a
  zero: "did not move" is a claim, "we cannot say" is not the same claim), four
  source-labelled overview tiles, the competitor aggregate, per-target rank
  history, ranking-URL changes, the alert feed.
- `src/server/dashboard/reconciliation.ts` — §8's explainer. Takes the resolved
  Search Console point and the nearest live checks and writes prose naming the
  specific blocks responsible for the gap. 25 tests.
- `src/server/dashboard/detail.ts` — composes one keyword's detail page from the
  functions that already own each rule. It does **not** merge the two series.
- `src/components/charts/` — the dual-series chart, the sparkline, the SERP
  strip, and `chart-theme.ts` (the validated palette and the axis helpers).
- `src/components/dashboard/`, `src/components/ui/` — tiles, tables, the source
  tag that sits beside every position number, the delta, "check now".
- `scripts/seed-demo-data.ts` (`pnpm db:demo`) — 28 days of **synthetic** data:
  337 Search Console rows, 3016 checks, 754 rollups. It deliberately contains
  gaps, zero-impression days, an open not-found stretch, a furniture-gap
  divergence, a ranking-URL change and two locations that disagree, because
  every one of those is a rendering path that is otherwise never exercised.
  `pnpm db:demo --clear` removes it.

**Two decisions worth not re-litigating.**

1. _The chart keeps two data arrays, not one._ A Search Console date is a
   Pacific calendar day; a live check is an instant. They share a **time** axis,
   with each GSC day anchored at its own Pacific midday — the same anchor the
   reconciliation uses. Folding them into shared "day" rows would mean deciding
   that a Pacific day and the property's IST day are the same day. They are
   12.5–13.5 hours apart, and `daily_rank_rollups` buckets by the property
   timezone while `gsc_snapshots` stores the Pacific date. Both are right; they
   are not the same grid.
2. _The colours are computed, not chosen._ `--source-serp` / `--source-gsc` /
   `--source-absolute` in `globals.css` are the validated categorical slots 1–3,
   stepped separately for each mode. If you change one, re-run the validator
   rather than eyeballing it. Aqua sits under 3:1 on the light surface, which is
   why every `rank_absolute` value also appears as text in the tooltip and the
   table — that pairing is the mitigation, not an accident.

**What M7 built.**

- `src/server/alerts/rules.ts` — pure. Takes a day's facts, returns candidates;
  no database, no clock. Thresholds, severities and signatures are all testable
  without standing anything up.
- `src/server/alerts/engine.ts` — the gather step. One query for both days plus
  two event signals, then the rules, then the write.
- `PATCH /api/alerts/:id` and `POST /api/properties/:id/alerts` — read, unread,
  resolve, mark-all. Every mutation goes through the scope, so the property
  predicate is applied by the thing that performed the tenancy check.

_The signature is the whole design._ It is `sha256(type + target + bucket)`,
and the bucket is never a date: for a STATE (out of the top ten, gone from the
results) it is empty, because there is one way to be in that state; for a MOVE
it is the position moved from, so 5 → 15 and a later 15 → 40 are two alerts
while re-detecting the same 5 → 15 hourly is one; for an EVENT it is what
happened. The partial unique index on `signature WHERE resolved_at IS NULL`
then makes a repeat a no-op insert — which also means resolving is load-bearing
rather than cosmetic: an open alert holds its signature and suppresses a
recurrence, so an engine that only ever opened alerts would fire each condition
exactly once, for ever.

_A rollup built from one check IS that check._ Reading a rollup does not by
itself satisfy §9's "never a single check", so a day resting on fewer than
`MIN_CHECKS_PER_DAY` checks is not judged at all — neither raised on nor
resolved on, because a day you cannot judge is not evidence a condition
cleared.

**What M8 needs.** Playwright end-to-end coverage (`pnpm test:e2e` is wired but
there are no specs), API rate limits beyond the check-now cooldown, empty and
error states on every page, and a runbook. **ESLint is not configured** —
`pnpm lint` drops into the Next.js setup prompt. That is a real gap and belongs
here.

**Standing caveats.** Nothing in this repository has touched a live Google or
DataForSEO API. Both fixture sets are hand-written and labelled as such. The
`location_code` values in `src/server/db/seed-data.ts` are unverified
placeholders — `pnpm verify:dataforseo` checks them, and a stale code returns
rankings for the wrong geography **without erroring**, so run it before the
first paid batch.

### What "against fixtures" means

No Search Console credentials existed in the build environment, so M2's
verification target — _"reproduce the known series for `prestige sector 150
noida`, roughly 35.0 on 31 Aug improving to 7.8 by 9 Sep"_ — has **not** been
run. The GSC fixtures are hand-written from Google's API reference and labelled
as such in `src/test/fixtures/README.md`.

Two things are genuinely unknown until you run `pnpm verify:gsc`:

1. Whether `["date","hour","query"]` is accepted in one request. Both paths are
   implemented and the fallback is tested; the probe decides at runtime.
2. The `hour` dimension key format — bare `"13"` or a full ISO timestamp.
   `parseHourKey` handles both, and both are covered by tests.

`pnpm verify:gsc --save-fixtures` answers both and rewrites the fixtures with
real captures. Everything else in M2 is verified against a real Postgres.

The same applies to M3: `src/test/fixtures/dataforseo/*.json` are hand-written
to the documented advanced-SERP shape. `pnpm verify:dataforseo --live` fetches a
real one ($0.0020) and saves it alongside. The parser, the batching, the webhook
and the idempotency are all verified against a real Postgres; only the _response
shape_ is assumed.

---

## Quick start

```bash
pnpm install
cp .env.example .env.local        # fill in — see requirements.md
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Then check <http://localhost:3000/api/health>. `"migrated": true` means the
schema is present.

---

## Commands

| Command                           | Purpose                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| `pnpm dev`                        | Development server                                                                    |
| `pnpm build`                      | Production build                                                                      |
| `pnpm typecheck`                  | `tsc --noEmit`, strict                                                                |
| `pnpm test`                       | Unit tests. Offline — no network, no database                                         |
| `pnpm test:tz`                    | The suite under `TZ=America/Los_Angeles`, to catch timezone-dependent date arithmetic |
| `TEST_DATABASE_URL=... pnpm test` | Also runs the integration suite against a real Postgres                               |
| `pnpm db:generate`                | Generate a migration from schema changes                                              |
| `pnpm db:migrate`                 | Apply pending migrations (uses the **unpooled** connection)                           |
| `pnpm db:seed`                    | Seed org, admin, property, keywords, targets. Idempotent                              |
| `pnpm db:demo`                    | 28 days of **synthetic** dashboard data. `--clear` removes it                         |
| `pnpm db:studio`                  | Drizzle Studio                                                                        |
| `pnpm verify:gsc`                 | Check Search Console credentials and property access                                  |
| `pnpm verify:dataforseo`          | Check DataForSEO balance and location codes (free)                                    |
| `pnpm verify:dataforseo --live`   | Also fetch one live SERP ($0.0020) and save it as a fixture                           |

---

## Layout

```
src/
  lib/
    env.ts            The ONLY reader of process.env. Zod-validated, cached
    redact.ts         Secret scrubbing for anything reaching a log or response
    logger.ts         Structured JSON logs, key-aware redaction
    retry.ts          3 attempts, full jitter, 429/5xx only — never a 400
    concurrency.ts    Bounded parallelism; failures captured, not thrown
    gsc-dates.ts      Pacific Time arithmetic — domain rule 4 lives here
    utils.ts          cn() for shadcn
  middleware.ts       Coarse page gate only — NOT the security boundary
  server/
    db/
      schema.ts       Full schema: tenancy, tracking, GSC, SERP, rollups, alerts, ops
      scoped.ts       forProperty(): a scope you cannot construct without access
      index.ts        Drizzle handle (Neon HTTP in prod, node-postgres elsewhere)
      seed.ts         Idempotent seed
      seed-data.ts    Property, keywords and location codes — verify before paid runs
    alerts/
      rules.ts        Pure: a day's facts in, alert candidates out. No DB, no clock
      engine.ts       Gathers the facts, writes what fires, resolves what cleared
    ops/
      cron-jobs.ts    The job registry: what each cron name actually runs
      rollups.ts      Daily rank rollups — storage control and alert baselines
      retention.ts    Prune, with guards that refuse to delete unrolled days
      queries.ts      /ops data: run health, freshness, month-to-date spend
    auth/
      access.ts       THE tenancy rule: assertPropertyAccess, forProperty's gate
      credentials.ts  bcrypt cost 12, email normalisation, timing-safe lookup
      config.ts       Auth.js wiring and currentPrincipal()
      ops-access.ts   /ops is agency_admin only
    api/
      respond.ts      One typed error shape. 403 never 404, for tenancy
    dashboard/
      queries.ts      Every dashboard read, each figure carrying its source
      reconciliation.ts  §8: why the two numbers differ, in words
      detail.ts       One keyword's page. Keeps the two series separate
      page-scope.ts   pageScope(): forProperty for pages, /login or 403
    ingest/
      dataforseo-client.ts  HTTP Basic, batched task_post, Zod-validated responses
      serp-parse.ts   THE SERP parser: rank_group vs rank_absolute, competitors, features
      serp.ts         Batching, pingback handling, live check-now
      gsc-client.ts   JWT auth, Zod-validated responses, dimension key parsing
      gsc-series.ts   THE read-precedence resolver. Pure — no database import
      gsc-read.ts     One indexed range scan, then the resolver
      gsc-upsert.ts   API row → DB row, duplicate merging, idempotent write
      gsc.ts          The three jobs: hourly, reconcile, backfill
      runs.ts         ingest_runs lifecycle
  app/
    api/health/       Liveness + schema check
    api/webhooks/dataforseo/  Pingback. 401 unauthenticated, 200 for everything else
    api/cron/[job]/   Authenticated dispatcher. Bearer header or ?secret=
    api/auth/         Auth.js handlers
    api/properties/   Properties this session may read
    api/keywords/[id]/  Keyword detail, tenancy-checked
    api/keyword-targets/[id]/check/  "Check now". Spends $0.0020 per success
    p/[propertyId]/   The dashboard: overview, keywords, detail, competitors, alerts
    login/            Sign-in (server action; the password never reaches a bundle)
    ops/              Ingest health and spend — agency_admin only
  components/
    ui/               card, badge, table
    charts/           rank-chart (three series, one inverted axis), sparkline,
                      serp-strip, chart-theme (validated palette + axis helpers)
    dashboard/        tiles, keyword table, source tag, delta, check-now,
                      reconciliation panel, nav
    theme-toggle.tsx  light / system / dark, stamped before first paint
  test/
    setup.ts          Offline-by-default test bootstrap
    fixtures/         READ fixtures/README.md — the GSC ones are synthetic
scripts/
  verify-gsc.ts       requirements.md §4
  verify-dataforseo.ts  requirements.md §§6–7
drizzle/              Generated migrations — commit these
```

---

## Rules the code enforces

Each has a test.

1. **Never average a GSC position with a DataForSEO rank.** Different
   measurements. Every stored number carries its source.
2. **Store both rank fields.** `rank_group` and `rank_absolute`, plus the gap.
3. **Hourly Search Console data is provisional.** Written as `data_state =
'hourly'`, re-fetched as `final` four days later into a _separate_ row. The
   provisional value is never deleted — the size of the revision is the signal.
4. **Search Console dates are Pacific Time.** Stored exactly as returned, in a
   `date` column. Converted only for display. `src/lib/gsc-dates.ts` is the only
   place that computes one.
5. **"Not found" is not position 100.** `found = false` with NULL ranks. A
   sentinel silently corrupts every aggregate downstream.
6. **Fewer than 3 impressions is noise.** Stored, excluded from alerts, flagged
   low-confidence in the UI.
7. **Record the ranking URL on every check.** A stable position with a changed
   ranking URL is a notable event.
8. **Multiple ranking URLs:** best `rank_group` wins, the full set is stored.
9. **Every ingest is idempotent.** Unique constraint on each natural key plus
   `ON CONFLICT DO UPDATE`. See `NOTES.md` §1 for the `NULLS NOT DISTINCT`
   subtlety that makes this actually true.
10. **Rank axes are inverted.** Position 1 at the top, and always labelled — an
    inverted axis whose top tick is "7" rescales every chart to its own best
    result. A chart where improvement points down is a bug.
11. **A gap is a gap.** `connectNulls={false}` on every series. A null is never
    plotted as a zero, as a line to the bottom of the chart, or as a segment
    joining the two points either side of it.
12. **Series differ by more than colour.** Three stroke patterns as well as
    three hues, because clients print these charts. The palette itself is
    checked with the data-viz validator rather than judged by eye.
13. **One alert per condition, not one per day.** The signature is stable while
    a condition persists and changes when it is genuinely a new one; the partial
    unique index makes a repeat a no-op insert.
14. **Never alert on a single check.** Neither side of a comparison may rest on
    a day that aggregated fewer than two checks — and such a day cannot resolve
    an alert either.

---

## Security

- `process.env` is read in exactly two files: `src/lib/env.ts` and
  `drizzle.config.ts` (which runs outside the Next.js runtime).
- Validation failures report variable **names and reasons, never values**.
- Every error leaving a catch block goes through `redactError()`, which strips
  connection-string passwords, PEM blocks, `Authorization` headers and
  `secret=` / `token=` parameters.
- Cron and webhook routes authenticate with constant-time comparison. An
  unauthenticated pingback route is a public button that spends your DataForSEO
  balance.
- `.gitignore` covers `.env*` and `*service-account*.json`.

---

## Deployment

Vercel, Hobby-compatible. `vercel.json` registers one daily cron
(`/api/cron/daily`, which chains reconcile → rollup → prune). The hourly jobs
come from `.github/workflows/ingest.yml`, which hits the same dispatcher with a
Bearer header — see `requirements.md` §9 for the alternatives.

Set `APP_BASE_URL` and `CRON_SECRET` as GitHub Actions **secrets** for that
workflow to work.

| Job                                  | Driven by      | Schedule                           |
| ------------------------------------ | -------------- | ---------------------------------- |
| `ingest-gsc`                         | GitHub Actions | hourly at :05                      |
| `enqueue-serp`                       | GitHub Actions | hourly at :05                      |
| `backfill-gsc`                       | GitHub Actions | hourly at :05, no-op once complete |
| `daily` (reconcile → rollup → prune) | Vercel cron    | 04:00 UTC                          |

Every job is individually addressable, safe to run twice, and processes
properties independently.
