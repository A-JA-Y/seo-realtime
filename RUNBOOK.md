# Runbook

What to do when something is wrong. Written for the person on call at 02:00,
not for the person who built it.

Every entry follows the same shape: **what you see → what it means → what to
do**. Where a step costs money, the price is stated.

> **First stop: `/ops`.** It shows every ingest run, freshness per property, and
> month-to-date DataForSEO spend. Most of what follows starts by looking there.
> It is `agency_admin` only.

---

## 0. Orientation

| Thing | Where |
|---|---|
| Ingest health, freshness, spend | `/ops` |
| Liveness + "is the schema migrated" | `GET /api/health` |
| Job history | `ingest_runs` table, or `/ops` |
| What each cron name runs | `src/server/ops/cron-jobs.ts` |
| Scheduled jobs | `.github/workflows/ingest.yml` (hourly), `vercel.json` (daily) |

Every job is **individually addressable, safe to run twice, and processes
properties independently**. There is no job you can make worse by re-running.

```bash
curl -fsS -X POST "$APP_BASE_URL/api/cron/<job>" \
  -H "Authorization: Bearer $CRON_SECRET"
```

Jobs: `ingest-gsc`, `reconcile-gsc`, `backfill-gsc`, `enqueue-serp`, `rollup`,
`alerts`, `prune`, `daily`.

---

## 1. The dashboard is showing stale numbers

**What you see.** `/ops` shows a property's Search Console freshness over the
staleness threshold, or ranks that have not moved since yesterday.

**What it means.** One of the hourly jobs has stopped running, or is running and
failing. These are different and `/ops` distinguishes them: a job that is not
running leaves no `ingest_runs` row at all; a job that is failing leaves rows
with status `failed` or `partial`.

**What to do.**

1. `/ops` → recent runs. Is there a row for the last hour?
   - **No row:** the scheduler is not firing. Check the GitHub Actions run
     history for `.github/workflows/ingest.yml`. The usual cause is a missing or
     rotated `APP_BASE_URL` / `CRON_SECRET` **repository secret** — Actions
     cannot read `.env.local`.
   - **A `failed` row:** read its `failure_reasons`. They are redacted, so they
     are safe to paste into a ticket.
2. Re-run the job by hand with the curl above. It is idempotent.
3. If it fails by hand too, go to §2 or §3 depending on which provider.

**What NOT to do.** Do not "fix" staleness by re-running the backfill. The
backfill fills HISTORY; it will not fetch today.

---

## 2. Search Console ingestion is failing

**What you see.** `ingest_runs` rows with `kind` `gsc_hourly` / `gsc_reconcile`
and status `failed`.

**Read the reason first.** It is the fastest classifier:

| Reason contains | Meaning | Action |
|---|---|---|
| `PEM` / `DECODER` | The private key's `\n` escapes did not survive | §2a |
| `403` / `insufficient permissions` | The service account is not on the property | §2b |
| `User does not have sufficient permission for site` | Same, or the wrong site URL form | §2b |
| `429` / `quota` | Rate limited | §2c |
| `400` and a dimension list | The `hour` dimension combination was rejected | §2d |

### 2a. Private key decoding

`GOOGLE_PRIVATE_KEY` in the JSON contains literal `\n` sequences. Pasted into a
Vercel environment variable they stay escaped and the crypto library rejects
them. `src/lib/env.ts` unescapes once, centrally — but only if the value
arrived with the escapes intact.

**Fix.** Re-paste the value **wrapped in double quotes** so dotenv keeps the
escapes. Redeploy. `pnpm verify:gsc` confirms it without spending anything.

### 2b. Permissions

**Fix.** In Search Console, add the service account's `client_email` as a
**Full** user on the property. Then `pnpm verify:gsc` — it prints every site the
credential can see, so a mismatch between `gsc_site_url` and what Google
actually calls the property shows up immediately (`sc-domain:example.com` and
`https://example.com/` are different properties).

### 2c. Quota

Search Console allows 1,200 queries/minute/site. Hitting it means something is
looping. The retry helper already backs off on 429 — check `/ops` for a burst
of runs in the same minute before adding any manual throttle.

### 2d. Dimension rejection

Whether `["date","hour","query"]` is accepted in one request is not documented
consistently. Both paths are implemented and the fallback is tested; the probe
decides at runtime and caches the answer on the property
(`gsc_dimension_mode`).

**If it is stuck in the wrong mode:** set `gsc_dimension_mode` back to
`'unknown'` for that property and the next run re-probes.

```sql
UPDATE properties SET gsc_dimension_mode = 'unknown', gsc_dimension_probed_at = NULL
WHERE id = '<property-id>';
```

---

## 3. DataForSEO is failing

### 3a. Tasks submit but results never arrive

**What you see.** `serp_batch` runs succeed, `serp_checks` rows do not appear.

**What it means.** The pingback is not reaching you. DataForSEO POSTs results to
`APP_BASE_URL/api/webhooks/dataforseo?secret=…`; if that URL is wrong,
unreachable, or the secret does not match, the result is dropped and **you have
already paid for it**.

**What to do.**

1. Check `APP_BASE_URL` has no trailing slash and is the deployed origin.
2. Check `DATAFORSEO_PINGBACK_SECRET` matches between the environment and what
   the enqueue job builds. It is compared in constant time; a mismatch is a 401
   with no detail, by design.
3. DataForSEO's dashboard shows delivery attempts per task. If it shows 401s,
   it is the secret. If it shows timeouts, it is the URL.
4. Results are also retrievable by task id. A task that was paid for and never
   delivered can be fetched rather than re-submitted — **re-submitting pays
   twice**.

### 3b. Balance exhausted

**What you see.** Task submission rejected; `/ops` month-to-date spend near the
top-up.

**What to do.** Top up. Nothing is lost: `enqueue-serp` claims targets before
spending (`FOR UPDATE SKIP LOCKED`), so an unfunded run releases them for the
next one rather than marking them checked.

### 3c. Ranks for the wrong country

**What you see.** Positions that look nothing like what you see in a browser, no
errors anywhere.

**What it means.** A stale `location_code`. **DataForSEO returns rankings for
whatever code you send and does not error on an outdated one.** This is the
failure mode that produces a confident wrong answer.

**What to do.** `pnpm verify:dataforseo` (free) lists the live codes. Correct
`keyword_targets.location_code`. Historic rows stay as they are — they are not
wrong, they measured a different place, and rewriting them would destroy the
evidence of the mistake.

---

## 4. Alerts stopped arriving

**What you see.** The Alerts tab is quiet and you do not believe it.

**The most likely cause is the least alarming one:** nothing crossed a
threshold. Check that first — the feed shows resolved alerts too, so a genuinely
quiet period looks different from a broken engine.

**Then, in order:**

1. `/ops` → is there an `alerts` run in the last hour? No row means the job is
   not firing (§1). A row with `rows_written: 0` means it ran and found nothing.
2. Alerts need **rollups**. The engine reads `daily_rank_rollups`, never raw
   checks. If `rollup` is failing, alerts go quiet without any alert saying so —
   which is why the hourly workflow runs `rollup` then `alerts` in one step, in
   that order.
3. A day resting on fewer than two checks is **not judged at all**. On a
   newly-onboarded property, or early in the day, that is expected and correct.
4. An open alert holds its signature. If a condition keeps happening and only
   alerted once, look for an **unresolved** alert with the same signature —
   that is the suppression working, not a bug.

**To re-evaluate a specific day by hand:**

```bash
curl -fsS -X POST "$APP_BASE_URL/api/cron/alerts" -H "Authorization: Bearer $CRON_SECRET"
```

This evaluates the latest day with a rollup. It is idempotent: re-running
raises nothing new.

---

## 5. Someone reports a number is wrong

Almost always one of four things, in descending order of likelihood.

1. **They are comparing a Search Console average with a rank.** They are
   different measurements. Open the keyword's detail page — the reconciliation
   panel explains the specific gap in words, naming the SERP blocks responsible.
   This is the answer, not a deflection.
2. **They are looking at a provisional figure.** Search Console revises for
   about four days. The UI marks provisional values; the finalised one lands
   later as a separate row and the provisional one is kept, so you can show them
   exactly how much Google moved it.
3. **The keyword had almost no impressions.** Below three impressions a position
   is noise. It is stored, excluded from alerts, and flagged in the UI.
4. **The location code is wrong.** See §3c. This is the one that is actually a
   bug.

**Never** "fix" a number by editing stored rows. Every figure carries its source
and its date; correcting the ingest and letting it re-run is the only safe move,
and every ingest is idempotent precisely so that is always available.

---

## 6. The database is filling up

**What you see.** Neon storage warnings.

**What to do.** `prune` deletes per-check rows older than 90 days — but only for
days that already have a rollup, so it cannot destroy history that was never
summarised.

```bash
curl -fsS -X POST "$APP_BASE_URL/api/cron/rollup" -H "Authorization: Bearer $CRON_SECRET"
curl -fsS -X POST "$APP_BASE_URL/api/cron/prune"  -H "Authorization: Bearer $CRON_SECRET"
```

Run `rollup` **first**. Pruning before rolling up deletes nothing (the guard
holds) and simply defers the reclaim.

The other growth surface is `serp_payloads`. Payloads are trimmed on write, and
there is one per check by constraint, so growth is proportional to checks.

---

## 7. A deploy broke something

1. **Roll back first, diagnose after.** Vercel keeps previous deployments; the
   database is forward-compatible because migrations are additive.
2. **Do not roll back a migration.** They add tables, columns and constraints;
   the previous build tolerates extra columns. Reverting the schema is what
   turns a bad deploy into a data-loss incident.
3. `GET /api/health` reports `"migrated": true/false`. `false` after a deploy
   means `pnpm db:migrate` did not run — it uses the **unpooled** connection
   string, and a missing `DATABASE_URL_UNPOOLED` is the usual reason.

---

## 8. Rotating a secret

Order matters for the two that authenticate inbound requests.

**`CRON_SECRET`** — set the new value in both places (the deployment environment
AND the GitHub Actions secret) before the next hour boundary. A mismatch means
the jobs 401 silently; §1 is how you would find out.

**`DATAFORSEO_PINGBACK_SECRET`** — this one has a tail. Tasks already submitted
carry the OLD secret in their pingback URL and will be rejected after rotation,
and those results are already paid for. Rotate just after an `enqueue-serp`
cycle completes, or accept losing one batch.

**`AUTH_SECRET`** — invalidates every session. Everyone signs in again. Harmless,
but do it deliberately rather than on a Friday.

**Never** commit the service-account JSON. `.gitignore` covers `.env*` and
`*service-account*.json`; the two fields the app needs go in the environment and
the original belongs in a password manager.

---

## 9. What good looks like

- `/ops` shows a run per hour for `ingest-gsc`, `enqueue-serp` and
  `rollup`/`alerts`, all `success`.
- Search Console freshness under the staleness threshold for every property.
- Month-to-date spend roughly `targets × checks-per-day × 30 × $0.0006`, plus
  whatever "check now" was pressed.
- `backfill-gsc` returning a no-op — it is complete and stays scheduled so a
  newly-added property is picked up without anyone remembering to.
