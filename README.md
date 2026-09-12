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

| Number | What it measures |
|---|---|
| `rank_group` | Which blue link you are. Organic results only. |
| `rank_absolute` | How far down the page you are. Counts every SERP element — AI Overview, local pack, images, People Also Ask, ads. |
| GSC average position | A click-weighted **mean** over every impression in a window, across all devices and locations. Continuous, provisional for days, revised after the fact. |

`rank_absolute` is what reconciles with Search Console, because Google counts
those blocks too. `rank_group` is what a human gets counting down the page. The
difference between them is the **SERP furniture penalty**.

Averaging a Search Console position with a DataForSEO rank produces a number
that measures nothing. The schema enforces the separation; every number in the
UI is labelled with its source.

---

## Status

| Milestone | State |
|---|---|
| **M1 — Foundation** | **Complete.** Next.js 15 + strict TS + Tailwind v4, Zod env validation, full Drizzle schema + migration, idempotent seed, health route, setup verification scripts |
| **M2 — Search Console ingestion** | **Complete against fixtures.** JWT auth, hourly job with the documented dimension fallback, `fresh` + `final` writers, resumable 16-month backfill, the single read-precedence function, retry policy, structured logging, `ingest_runs`. **Not yet verified against the live property** — see below |
| **M3 — DataForSEO ingestion** | **Complete against fixtures.** Batched `task_post`, secret-guarded pingback webhook, the parser, trimmed payload storage, live "check now" with its cooldown. **No live SERP has been fetched** — see below |
| M4 — Cron + ops | Not started |
| M5 — Auth + tenancy | Not started |
| M6 — Dashboard | Not started |
| M7 — Alerts | Not started |
| M8 — Hardening | Not started |

Pacific-time date handling (`src/lib/gsc-dates.ts`) landed early — the setup
checker needs it, and it encodes domain rule 4.

### What "against fixtures" means

No Search Console credentials existed in the build environment, so M2's
verification target — *"reproduce the known series for `prestige sector 150
noida`, roughly 35.0 on 31 Aug improving to 7.8 by 9 Sep"* — has **not** been
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
and the idempotency are all verified against a real Postgres; only the *response
shape* is assumed.

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

| Command | Purpose |
|---|---|
| `pnpm dev` | Development server |
| `pnpm build` | Production build |
| `pnpm typecheck` | `tsc --noEmit`, strict |
| `pnpm test` | Unit tests. Offline — no network, no database |
| `pnpm test:tz` | The suite under `TZ=America/Los_Angeles`, to catch timezone-dependent date arithmetic |
| `TEST_DATABASE_URL=... pnpm test` | Also runs the integration suite against a real Postgres |
| `pnpm db:generate` | Generate a migration from schema changes |
| `pnpm db:migrate` | Apply pending migrations (uses the **unpooled** connection) |
| `pnpm db:seed` | Seed org, admin, property, keywords, targets. Idempotent |
| `pnpm db:studio` | Drizzle Studio |
| `pnpm verify:gsc` | Check Search Console credentials and property access |
| `pnpm verify:dataforseo` | Check DataForSEO balance and location codes (free) |
| `pnpm verify:dataforseo --live` | Also fetch one live SERP ($0.0020) and save it as a fixture |

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
  server/
    db/
      schema.ts       Full schema: tenancy, tracking, GSC, SERP, rollups, alerts, ops
      index.ts        Drizzle handle (Neon HTTP in prod, node-postgres elsewhere)
      seed.ts         Idempotent seed
      seed-data.ts    Property, keywords and location codes — verify before paid runs
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
   'hourly'`, re-fetched as `final` four days later into a *separate* row. The
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
10. **Rank axes are inverted.** Position 1 at the top. A chart where improvement
    points down is a bug.

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
(`/api/cron/daily`, which chains reconcile → rollup → prune). Hourly jobs come
from an external scheduler hitting the same dispatcher with `?secret=` — see
`requirements.md` §9.
