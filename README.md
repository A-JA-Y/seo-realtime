# Rank Tracker

Near-realtime Google rank tracking for a multi-property SEO agency. Ingests
**Search Console average position** and **DataForSEO true rank** side by side,
keeps them rigorously separate, and makes the gap between them an explainable
feature rather than a support ticket.

> **Setup first.** [`requirements.md`](./requirements.md) provisions every
> account and credential this needs, with a verification step after each one.
> When something is wrong, [`RUNBOOK.md`](./RUNBOOK.md) says what to do about
> it. Deliberate deviations from the build spec are recorded in
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
| **M8 — Hardening**                | **Complete.** ESLint (flat config, zero findings), Playwright end-to-end suite on desktop and phone, table-backed API rate limits, error / empty / loading states, migration-integrity guards, and [`RUNBOOK.md`](./RUNBOOK.md)                                                                      |

Pacific-time date handling (`src/lib/gsc-dates.ts`) landed early — the setup
checker needs it, and it encodes domain rule 4.

### After M8: an adversarial audit

M6-M8 were reviewed the way M2 and M3 were: 14 finders, three independent
skeptics per finding, a completeness critic. **56 candidates, 33 confirmed, 23
refuted.** All 33 are fixed; the refutations are recorded in NOTES §85 so nobody
re-reports them.

The six that mattered most, and what they have in common:

| What                                                                                                | Why it survived until now                                                                                                  |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Dashboard Δ columns indexed **property-timezone** rollups with a **Pacific** date                   | The grids agree for half of every day, so it looked right whenever anyone checked after lunch                              |
| The Δ subtracted a **daily minimum** from a **single live check**                                   | Both numbers are ranks; nothing about the types said they were not comparable                                              |
| Every scheduled check recorded **`cost_usd = 0`**                                                   | `task_get` returns `cost: 0`, not null, and `??` does not catch a zero — so `/ops` read $0.00 while the account was billed |
| Pruning cut at an **instant**, then the unbounded rollup overwrote that day from the surviving half | Two individually correct decisions; only their combination destroys data                                                   |
| "Check now" returned a **driver error, with the failing SQL**, to the client                        | `redactError` strips credentials, and the call site's comment claimed it stripped more                                     |
| One trend raised **22 daily alerts**                                                                | The signature bucketed on a baseline that slides                                                                           |

Five of the six are cases where the code did what its author meant and the
comment above it asserted something slightly stronger than the code delivered.
That is the failure mode to watch for in this repository specifically: it is
heavily commented, and a confident comment reads as a guarantee.

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
  It also walks the alert engine forward across the window, so the feed is
  populated — a demo with an empty alerts page is not a demo, and its
  end-to-end tests skip themselves when there is nothing to act on.
  `pnpm db:demo --clear` removes all of it, derived rows included.

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

**What M8 built.**

- **ESLint**, flat config, zero findings. The Next plugin directly rather than
  `eslint-config-next`, which still ships the legacy rushstack patch and will
  not load under flat config. The repository's OWN rules — the `process.env`
  boundary, routes reaching past the scoped query layer — stay in
  `env-boundary.test.ts`, because they are assertions that should fail the
  suite rather than warnings a lint run can be told to ignore.
- **Playwright**, desktop and phone, against a real server and a real database
  seeded with `pnpm db:demo`. It covers the acceptance criteria that are only
  checkable on screen: that every tile names its source, that a null renders as
  a gap, that the rank axis really is inverted, that "check now" shows its price
  before it is pressed.
- **Rate limits**, in a table rather than in memory — a serverless in-memory
  counter enforces the limit per instance, so the effective ceiling rises with
  concurrency, which is backwards. One statement per check, so a burst cannot
  slip through a read-then-write gap.
- **Error, empty and loading states** on every page, including a 403 that says
  what it means.
- **Migration integrity guards**, after a real near-miss (see NOTES §68).
- [`RUNBOOK.md`](./RUNBOOK.md) — what to do when something is wrong, written
  for 02:00.

**Four bugs the end-to-end suite found that nothing else had.**

1. The "no access to this property" page was **unreachable in production**, for
   two independent reasons. Next replaces a server error's message with a
   generic string before it reaches `error.tsx`, so a boundary matching on the
   message works in development and silently stops working in the only
   environment that matters — it matches on `digest` now. And **an error thrown
   in a layout is caught by the PARENT segment's boundary**, so the tenancy
   check in the property layout never reached the property's own boundary at
   all. Neither is visible in the code.
2. The loading skeleton was a second `<main>`, so during the streaming handoff
   the document briefly had two main landmarks — which is a document with no
   main content as far as a screen reader is concerned.
3. `/api/health` reported `migrated: true, 12 of 12` against a database missing
   two tables: the expected-table list was hand-written and had drifted. It is
   derived from the schema now, and a test proves a migration creates each one.
4. A migration file was **empty and recorded as applied** — a header comment
   prepended with `open(p,'w').write(header + open(p).read())`, which truncates
   before it reads. Two guards now make that impossible to repeat.

**Not done, and deliberately so.** The non-goals from the brief stand: no
external notification channels, no keyword research, no backlinks, no marketing
site or billing, and no scraper of our own.

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
| `pnpm lint`                       | ESLint, flat config. Zero findings is the expected state                              |
| `pnpm test:e2e`                   | Playwright, desktop + phone. Builds and starts its own server                         |
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
      rate-limit.ts   Fixed windows in a table — memory is per-instance and lies
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
e2e/                  Playwright specs — the criteria only checkable on screen
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

- `process.env` is read in exactly three files: `src/lib/env.ts`,
  `drizzle.config.ts` and `scripts/vercel-build.mjs` — the last two run
  outside the Next.js runtime, before the app exists. A test enforces the list.
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

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FA-JA-Y%2Fseo-realtime&project-name=rank-tracker&repository-name=seo-realtime&env=DATABASE_URL,DATABASE_URL_UNPOOLED,GOOGLE_SERVICE_ACCOUNT_EMAIL,GOOGLE_PRIVATE_KEY,DATAFORSEO_LOGIN,DATAFORSEO_PASSWORD,DATAFORSEO_PINGBACK_SECRET,CRON_SECRET,AUTH_SECRET,DEMO_MODE,SEED_ADMIN_EMAIL,SEED_ADMIN_PASSWORD,SEED_CLIENT_EMAIL,SEED_CLIENT_PASSWORD&envDescription=Every%20variable%20is%20explained%20in%20requirements.md%20section%2011.%20Leave%20APP_BASE_URL%20and%20AUTH_URL%20unset%3A%20they%20default%20to%20the%20Vercel%20production%20URL.&envLink=https%3A%2F%2Fgithub.com%2FA-JA-Y%2Fseo-realtime%2Fblob%2Fclaude%2Fconfident-ritchie-7wv99d%2Frequirements.md)

One click, then paste your `.env` values into the form Vercel shows. Everything
below is what that button sets in motion, so it can also be done by hand.

**If you own this repository, do not use the button.** It _clones_ the source
into a new repository under your account, which collides with the one you
already have — or leaves you deploying a copy that drifts from this branch. Go
to <https://vercel.com/new>, pick `A-JA-Y/seo-realtime` under _Import Git
Repository_, and deploy. Production then tracks the default branch, and every
push redeploys.

When you paste a `.env` file into Vercel's environment form, **leave three
lines out**:

| Leave out             | Why                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| `APP_BASE_URL`        | it says `localhost:3000`; unset, it defaults to the Vercel URL. An explicit wrong value breaks sign-in. |
| `AUTH_URL`            | same — Auth.js redirects to whatever this says                                                         |
| `SKIP_ENV_VALIDATION` | it exists for CI builds; on a real deployment it hides a missing variable until the first request       |

Every other line goes in as-is, `GOOGLE_PRIVATE_KEY` included — the `\n`
sequences inside it are unescaped by the app.

### What happens on deploy

1. **Vercel runs `pnpm build:vercel`** (set in `vercel.json`), which applies
   pending migrations against `DATABASE_URL_UNPOOLED` and then builds. Vercel
   does not run migrations on its own; without this step the first request
   would 500 on a missing table.
2. **`APP_BASE_URL` and `AUTH_URL` default themselves.** Both must match the
   served origin exactly, but on a first deploy the origin does not exist yet.
   When unset, they fall back to `https://` + Vercel's
   `VERCEL_PROJECT_PRODUCTION_URL`. Set them explicitly only for a custom
   domain.
3. **`/api/health`** reports `"migrated": true` once the schema is present.

### Database

Any Postgres 15+ works. The two strings come from Neon (`requirements.md` §8):
the **pooled** one is `DATABASE_URL`, the **direct** one is
`DATABASE_URL_UNPOOLED`. Vercel's Storage tab can create a Neon database and
inject both automatically if you would rather not manage them.

### Demo credentials

The demo accounts are whatever **you** set — the repository never contains a
password, and nothing returns one. For a demo project, set in Vercel:

| Variable               | Suggested value                                                              |
| ---------------------- | ---------------------------------------------------------------------------- |
| `DEMO_MODE`            | `1` — allows synthetic data to be seeded. **Never on a production project.** |
| `SEED_ADMIN_EMAIL`     | `demo-admin@example.com` — sees everything, including `/ops`                 |
| `SEED_ADMIN_PASSWORD`  | your choice, 8+ characters                                                   |
| `SEED_CLIENT_EMAIL`    | `demo-client@example.com` — a retainer client, scoped to one property        |
| `SEED_CLIENT_PASSWORD` | your choice, 8+ characters                                                   |

Then, once the deploy is live, seed the accounts and 28 days of synthetic
history with one call:

```bash
curl -X POST "https://<your-app>.vercel.app/api/cron/bootstrap-demo" \
  -H "Authorization: Bearer $CRON_SECRET"
```

It answers with the account emails and the row counts, never a password. It is
idempotent — run it again and the history is regenerated, the accounts are
untouched. It refuses outright unless `DEMO_MODE=1`, because the cron secret
authorises running jobs, not filling a database with fiction.

Sign in at `https://<your-app>.vercel.app/login`. The client account shows the
product as a client sees it; the admin account adds `/ops`.

To remove the synthetic data later, point a local checkout at the same
database and run `pnpm db:demo --clear`. Then turn `DEMO_MODE` off.

### Deploying from CI instead

`.github/workflows/deploy.yml` deploys on push and can seed the demo on demand.
It needs four repository secrets — `VERCEL_TOKEN`, `VERCEL_ORG_ID`,
`VERCEL_PROJECT_ID`, `CRON_SECRET` — under _Settings → Secrets → Actions_.
Until they exist it skips itself with a notice rather than failing. This is the
way to let an agent redeploy without a token ever passing through a chat.

### Scheduled work

`vercel.json` registers one daily cron (`/api/cron/daily`: reconcile → rollup →
prune → alerts) — Hobby allows once a day.

**Nothing in this repository schedules the hourly jobs.** The GitHub Actions
workflow that used to (`.github/workflows/ingest.yml`) has been removed. Until
you wire one of the options in `requirements.md` §9, a deployment ingests
nothing: no Search Console rows, no SERP checks, and the dashboard stays empty
— or, in demo mode, frozen at the day it was seeded.

The cheapest option is a free external scheduler (cron-job.org or similar)
calling the dispatcher hourly, in this order:

```
https://<your-app>.vercel.app/api/cron/ingest-gsc?secret=$CRON_SECRET
https://<your-app>.vercel.app/api/cron/enqueue-serp?secret=$CRON_SECRET
https://<your-app>.vercel.app/api/cron/rollup?secret=$CRON_SECRET
https://<your-app>.vercel.app/api/cron/alerts?secret=$CRON_SECRET
```

`GET` with `?secret=` exists precisely for schedulers that cannot set headers;
the comparison is constant-time. On Vercel Pro, register them in `vercel.json`
instead (`"schedule": "5 * * * *"`) — on Hobby that same entry fails the deploy.

| Job                                           | Driven by      | Schedule                        |
| --------------------------------------------- | -------------- | ------------------------------- |
| `ingest-gsc`                                  | your scheduler | hourly                          |
| `enqueue-serp`                                | your scheduler | hourly                          |
| `backfill-gsc`                                | your scheduler | hourly, no-op once complete     |
| `rollup` then `alerts`                        | your scheduler | hourly, **in that order**       |
| `daily` (reconcile → rollup → prune → alerts) | Vercel cron    | 04:00 UTC                       |
| `bootstrap-demo`                              | you, once      | needs `DEMO_MODE=1`             |

The order of `rollup` then `alerts` is load-bearing, not cosmetic. Alert
baselines come from `daily_rank_rollups` (§9), so an engine that ran before the
rollup would evaluate today against a rollup that does not exist yet and quietly
find nothing — a silent alerting system, which is the failure mode nobody
notices.

Every job is individually addressable, safe to run twice, and processes
properties independently.
properties independently.
