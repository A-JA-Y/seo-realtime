# Requirements — accounts, API keys and dashboard access

Everything to provision **before** the application can run. Work top to bottom.
Each section ends with a verification you must actually execute. If one fails,
fix it there — a broken credential carried into the build surfaces later as a
confusing runtime error rather than an obvious setup error.

**What this provisions:** Google Search Console API + DataForSEO SERP API →
Neon Postgres → Next.js on Vercel. Multi-tenant, in-app alerting only.

**Time:** about 90 minutes, plus DataForSEO payment clearing.

---

## Contents

1. [Google Cloud project & Search Console API](#1-google-cloud-project--search-console-api)
2. [Service account & JSON key](#2-service-account--json-key)
3. [Grant the service account access to each property](#3-grant-the-service-account-access-to-each-property)
4. [Verify the Search Console API](#4-verify-the-search-console-api)
5. [DataForSEO account & credentials](#5-dataforseo-account--credentials)
6. [Resolve location codes](#6-resolve-location-codes)
7. [Verify DataForSEO](#7-verify-dataforseo)
8. [Neon Postgres](#8-neon-postgres)
9. [Vercel project & cron](#9-vercel-project--cron)
10. [Auth & dashboard access](#10-auth--dashboard-access)
11. [Environment variable reference](#11-environment-variable-reference)
12. [Pre-flight checklist](#12-pre-flight-checklist)
13. [Cost model](#13-cost-model)
14. [Known gotchas](#14-known-gotchas)

---

## 1. Google Cloud project & Search Console API

The Search Console API is free and needs no billing account, but it still needs
a Cloud project to issue credentials against.

1. Go to <https://console.cloud.google.com/> and sign in with the Google account
   that **already owns your Search Console properties**.
2. Top-left project picker → **New Project**.
   - Name: `rank-tracker`
   - Note the auto-generated **Project ID** (e.g. `rank-tracker-481203`).
3. Enable the API at
   <https://console.cloud.google.com/apis/library/searchconsole.googleapis.com>
   with the new project selected → **Enable**.
   - Service name is `searchconsole.googleapis.com`, listed in the library as
     **Google Search Console API**. Do not pick the deprecated "Webmaster Tools
     API" entry.
4. No billing account, no OAuth consent screen, no quota increase. Default quota
   is 1,200 queries/minute per site, far beyond this workload.

> **Why no consent screen?** A service account authenticates as itself, not on
> behalf of a human. Consent screens apply only to user-facing OAuth flows.
> That is the main reason to prefer a service account for a cron job: no refresh
> token to expire, no re-consent in six months.

---

## 2. Service account & JSON key

1. **IAM & Admin → Service Accounts**
   (<https://console.cloud.google.com/iam-admin/serviceaccounts>) →
   **Create service account**.
   - Name: `rank-tracker-gsc`
   - Description: `Reads Search Analytics for the rank tracker cron`
2. **Skip the "Grant this service account access to project" step.** Click
   **Continue**, then **Done**. Search Console permissions are granted inside
   Search Console, not in Cloud IAM — project roles here do nothing useful and
   only widen the blast radius.
3. Copy the service account email:

   ```
   rank-tracker-gsc@rank-tracker-481203.iam.gserviceaccount.com
   ```

4. Open the service account → **Keys** → **Add key → Create new key → JSON →
   Create**. The file downloads once and cannot be re-downloaded.
5. Two fields from that JSON become environment variables:
   - `client_email` → `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `private_key`  → `GOOGLE_PRIVATE_KEY`

> **Security.** Never commit the JSON. `.gitignore` already covers
> `*service-account*.json`. Extract the two fields into `.env.local` and keep
> the original in a password manager. If it leaks, delete the key in the Keys
> tab — that revokes it immediately.
>
> **Rotation.** These keys do not expire. Rotate once a year: create a second
> key, deploy it, then delete the first.

---

## 3. Grant the service account access to each property

**This is the step people miss.** Enabling the API does not grant data access.
The service account is a separate identity and must be added as a user on every
property you track — one at a time, no bulk option.

For each property:

1. Open <https://search.google.com/search-console> and select the property.
2. **Settings** (left sidebar, bottom) → **Users and permissions** → **Add user**.
3. Email: the service account address from §2.
4. Permission: **Restricted**.

Restricted is sufficient. Restricted users have view access to the Performance /
Search Analytics report, which is all this app reads. Use Full only if you later
add URL Inspection or sitemap submission.

### Record the exact `siteUrl` string

The API identifies properties by a string that must match Search Console
*exactly*, and the format differs by property type. Getting it wrong produces
`403 User does not have sufficient permission for site` — which looks like a
permissions problem but is a string problem.

| Property type in GSC | Value to store in `properties.gsc_site_url` |
|---|---|
| URL-prefix | `https://prestigenoidasector150.com/` — trailing slash is part of the identifier |
| Domain | `sc-domain:prestigenoidasector150.com` |

Do not guess. §4's first call lists the canonical strings the service account
can actually see; copy from there.

---

## 4. Verify the Search Console API

Service accounts use a signed-JWT flow, awkward in raw `curl`. Use the checker
committed in this repo — it reads the same environment variables the app does:

```bash
cp .env.example .env.local        # then fill in the two Google values
pnpm verify:gsc
```

It makes two calls:

- **A — `sites.list`.** Prints every property the service account can see, with
  the exact `siteUrl` string to paste into your seed data.
- **B — `searchAnalytics/query`.** Pulls today's hourly rows for one keyword
  with `dataState: "hourly_all"`, and separately probes whether your property
  accepts `["date","hour","query"]` in a single request (§5 of the build spec
  needs that answer).

**Pass condition:** call A lists your property, and call B returns HTTP 200. An
empty `rows` array is a pass — it just means no impressions yet today. An error
is not.

### Interpreting failures

| Error | Cause | Fix |
|---|---|---|
| `403 Search Console API has not been used in project ...` | API not enabled | §1.3 |
| `403 User does not have sufficient permission for site` | Service account not added to the property, or wrong `siteUrl` format | §3 and the `siteUrl` table |
| `400 Invalid dataState` | Typo — the value is lowercase `hourly_all` | — |
| `error:0909006C:PEM routines` / `DECODER routines::unsupported` | `\n` in the private key not unescaped | Keep the double quotes around the value in `.env.local`; the app unescapes in `src/lib/env.ts` |
| `401 invalid_grant` | Server clock skew, or key deleted | Check system time; recreate the key |

### Capabilities that shaped the schema

- **Endpoint:** `POST https://www.googleapis.com/webmasters/v3/sites/{siteUrl}/searchAnalytics/query`
- **Scope:** `https://www.googleapis.com/auth/webmasters.readonly`
- **Dimensions:** `country`, `device`, `page`, `query`, `searchAppearance`, `date`, `hour`
- **`dataState`:** `final` (default, ~2–3 day lag), `all` (includes fresh partial
  data), `hourly_all` (hourly buckets, partial and revised later). Google's
  reference says `hourly_all` "should be used when grouping by the HOUR API
  dimension".
- **`rowLimit`:** 1–25,000, default 1,000.
- **Dates:** `YYYY-MM-DD` in **Pacific Time**, not your local timezone.
- Google "does not guarantee to return all data rows but rather top ones" — so
  always filter explicitly to the keyword you want rather than paging the whole
  set and hoping yours appears.
- **Undocumented:** whether `date` and `hour` may be grouped in one request.
  `pnpm verify:gsc` probes it and tells you which shape your property accepts.
  The ingest implements both and caches the answer.

---

## 5. DataForSEO account & credentials

1. Sign up at <https://dataforseo.com/>. A sandbox is available for testing
   request shapes without spending credit.
2. **Top up.** Minimum payment is **$50**, no smaller increment. At the volumes
   below this lasts years — treat it as a one-time float, not a monthly cost.
3. Credentials come from the dashboard's API access area.
   - `DATAFORSEO_LOGIN` is your account email.
   - `DATAFORSEO_PASSWORD` is the **API password shown in the dashboard**, which
     is *not* your account login password. Copy it; do not assume.
4. Auth is HTTP Basic: `Authorization: Basic base64(login:password)`.

   ```bash
   printf '%s' "you@example.com:YOUR_API_PASSWORD" | base64
   ```

### Endpoint tier

| Mode | Per SERP | Per 1,000 | Turnaround |
|---|---|---|---|
| **Standard queue** | $0.0006 | $0.60 | ~5 minutes |
| Priority queue | $0.0012 | $1.20 | ~1 minute |
| Live | $0.0020 | $2.00 | ~6 seconds |

**Standard queue for scheduled tracking.** Five minutes is irrelevant to an
hourly cron, and it is 3.3× cheaper than live. **Live** is reserved for the
dashboard's "check now" button, where a person is waiting.

Endpoints used:

- `POST /v3/serp/google/organic/task_post` — up to **100 tasks per request**
- `GET  /v3/serp/google/organic/task_get/advanced/{id}`
- `POST /v3/serp/google/organic/live/advanced`
- `GET  /v3/serp/google/locations`
- `GET  /v3/appendix/user_data` — balance

**Pingback, not polling.** Polling burns serverless invocations waiting on a
queue. A `pingback_url` turns the result into one inbound webhook. That route is
protected by `DATAFORSEO_PINGBACK_SECRET` — without it, your ingest endpoint is
a public button that spends your balance.

---

## 6. Resolve location codes

DataForSEO addresses geography by numeric `location_code`. **Look yours up.** Do
not guess and do not copy codes from blog posts — they change, and a stale code
silently returns rankings for the wrong geography without erroring.

```bash
pnpm verify:dataforseo --locations
```

or directly:

```bash
CREDS=$(printf '%s' "you@example.com:YOUR_API_PASSWORD" | base64)

curl -s 'https://api.dataforseo.com/v3/serp/google/locations' \
  -H "Authorization: Basic ${CREDS}" \
  | jq '.tasks[0].result[]
        | select(.country_iso_code == "IN")
        | select(.location_name | test("Noida|Delhi|Uttar Pradesh"; "i"))
        | {location_code, location_name, location_type}'
```

Pick deliberately:

- **City-level** (Noida) gives the rank a local buyer actually sees — the right
  number for a real-estate microsite, where the local pack and proximity matter.
- **Country-level** (India) is more stable and better for broad trend lines.

Track **both** for primary keywords. The divergence between them is itself a
signal, and it explains most "but I saw position 4" conversations.

Write the confirmed codes into `src/server/db/seed-data.ts` (`LOCATIONS`) before
the first paid run, then re-seed. They live in `keyword_targets.location_code`,
never in application code.

Also set per check: `language_code` (`en`, or `hi` where relevant), `device`
(`desktop` | `mobile`), `os` (`windows` | `android`), and `depth: 100` — fetching
the top 100 is what lets "not in top 100" be recorded as a real state rather
than a silent miss.

---

## 7. Verify DataForSEO

```bash
pnpm verify:dataforseo          # balance + location codes — free
pnpm verify:dataforseo --live   # ALSO one live SERP — costs $0.0020
```

The default run is free: it checks your balance and cross-checks the location
codes in `src/server/db/seed-data.ts` against what DataForSEO currently returns,
telling you if one has gone stale.

`--live` additionally runs one live SERP for your primary keyword at your
resolved location, prints both rank fields, the furniture gap and the competing
domains, and **writes the raw response to `src/test/fixtures/`**. Commit that
file — the parser's unit tests run against the real response shape rather than
against a guess at it.

Manually, the same two calls:

```bash
CREDS=$(printf '%s' "you@example.com:YOUR_API_PASSWORD" | base64)

# A) Balance — confirms credentials work
curl -s 'https://api.dataforseo.com/v3/appendix/user_data' \
  -H "Authorization: Basic ${CREDS}" | jq '.tasks[0].result[0].money'

# B) One live SERP. Replace LOCATION_CODE from §6.
curl -s -X POST 'https://api.dataforseo.com/v3/serp/google/organic/live/advanced' \
  -H "Authorization: Basic ${CREDS}" -H 'Content-Type: application/json' \
  -d '[{ "keyword": "prestige sector 150 noida", "location_code": LOCATION_CODE,
         "language_code": "en", "device": "mobile", "os": "android", "depth": 100 }]' \
  | jq '.tasks[0].result[0].items[] | select(.type=="organic")
        | {rank_group, rank_absolute, domain, url}'
```

**Pass condition:** A returns a positive balance; B returns a ranked list
including your domain.

### The two rank fields

| Field | Meaning |
|---|---|
| `rank_group` | Position counting **organic results only** — "which blue link am I" |
| `rank_absolute` | Position counting **every SERP element** — local pack, images, video, People Also Ask, AI Overview, ads |

`rank_absolute` is the field that reconciles with Search Console's average
position, because Google counts those blocks too. `rank_group` is what a human
gets counting down the page.

**Store both.** The gap between them measures how much SERP furniture is pushing
you down, and it is the single most useful number for explaining why "position
8" does not feel like position 8.

While you have the payload, capture the competing domains and the SERP features
too. It costs nothing extra — you already paid for the response — and it turns a
rank tracker into a competitive monitor.

> **Save the response.** `pnpm verify:dataforseo --live` does this for you.
> Commit the JSON it writes, redacting nothing but credentials — you want the
> real response shape, including the fields DataForSEO returns inconsistently.

---

## 8. Neon Postgres

1. Sign up at <https://neon.com/> (GitHub sign-in is fastest).
2. **Create project.**
   - Name: `rank-tracker`
   - Postgres version: **17** — the schema uses `UNIQUE NULLS NOT DISTINCT`,
     which needs 15 or newer. See `NOTES.md` §1 for why.
   - **Region: the Asia-Pacific region nearest you** (Singapore) to cut
     round-trip latency. Region cannot be changed after creation.
3. Copy **two** connection strings from the dashboard:
   - **Pooled** (host contains `-pooler`) → `DATABASE_URL`, used at runtime.
     Serverless functions open many short-lived connections; the pooler is what
     stops you exhausting Postgres connection slots.
   - **Direct** (no `-pooler`) → `DATABASE_URL_UNPOOLED`, used by migrations.
     drizzle-kit takes session-level advisory locks the transaction-mode pooler
     does not support.
4. **Branches → Create branch** from `main`, named `dev`. Point
   `TEST_DATABASE_URL` at it to run the integration suite:

   ```bash
   TEST_DATABASE_URL='postgresql://...dev...' pnpm test
   ```

### Free plan limits, and whether they hold

**0.5 GB storage per project**, **100 CU-hours per project per month**, 10
branches, and mandatory scale-to-zero after 5 minutes idle (cannot be disabled
on free).

- **Storage.** One snapshot row is roughly 300 bytes without the raw payload.
  Ten properties × 10 keywords × 2 devices × 2 geos × 24 hourly checks × 365
  days ≈ 3.5 M rows ≈ 1 GB. That exceeds 0.5 GB in year one. **Mitigation,
  already built in:** trimmed SERP payloads live in their own table with 30-day
  retention, and hourly rows roll into daily aggregates after 14 days.
- **Compute.** An hourly cron wakes the database 24 times a day; with the
  5-minute idle timeout that is roughly 2.4 hours wall time daily, about 18
  CU-hours a month at 0.25 CU. Comfortably inside 100.

Honest summary: compute is fine indefinitely; storage will push you to a paid
tier within a year unless retention runs. It runs from day one.

**Cold start.** Scale-to-zero means the first query after idle takes a few
hundred milliseconds to a couple of seconds. Irrelevant for a cron, noticeable
on a dashboard opened first thing in the morning. `/api/health` reports
`latencyMs` so a cold start reads as a cold start rather than an outage. If
clients complain, that is the signal to move to a paid plan — not a reason to
pre-empt it.

---

## 9. Vercel project & cron

1. Push the repo to GitHub, then import it at <https://vercel.com/new>.
2. Add every variable from §11 under **Settings → Environment Variables**, for
   Production, Preview and Development.
3. Cron is already configured in `vercel.json`.

### The cron frequency problem

| Plan | Minimum interval | Precision |
|---|---|---|
| **Hobby (free)** | **Once per day** | Per-hour (±59 min) |
| Pro ($20/mo) | Once per minute | Per-minute |

On Hobby, a cron expression that fires more than once a day **fails at deploy
time**. So hourly polling is not available from Vercel cron on the free plan.

`vercel.json` therefore registers exactly one daily job, `/api/cron/daily`,
which chains reconcile → rollup → prune. The hourly jobs come from outside.

**Option A — external scheduler (recommended to start).** Free, minute-level
granularity, keeps Vercel on Hobby. Point `cron-job.org` at:

```
https://your-app.vercel.app/api/cron/ingest-gsc?secret=YOUR_CRON_SECRET
https://your-app.vercel.app/api/cron/enqueue-serp?secret=YOUR_CRON_SECRET
```

The dispatcher accepts `GET` with `?secret=` precisely so a scheduler that
cannot set headers still works. The comparison is constant-time.

**Option B — GitHub Actions.** Free, no third-party account. Scheduled workflows
can be delayed under load, which is fine for hourly work. The repository does
not ship this workflow; create it yourself if you choose this option.

```yaml
# .github/workflows/ingest.yml
name: Rank ingest
on:
  schedule:
    - cron: '5 * * * *'   # hourly at :05 UTC
  workflow_dispatch:
jobs:
  ingest:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -fsS -X POST "${{ secrets.APP_BASE_URL }}/api/cron/ingest-gsc" \
            -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}"
          curl -fsS -X POST "${{ secrets.APP_BASE_URL }}/api/cron/enqueue-serp" \
            -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}"
```

**Option C — Vercel Pro.** $20/mo buys native per-minute cron. Move here when
the external scheduler becomes an operational annoyance, not before.

### Securing the cron route

Vercel's own cron invocations send `Authorization: Bearer $CRON_SECRET`
automatically when `CRON_SECRET` is set. Every cron route validates it and
rejects anything else. Generate it with `openssl rand -hex 32`.

### Function timeout

Hobby functions cap at 60 seconds. Batched `task_post` calls return immediately,
so the ingest route stays fast — and the build never polls `task_get` inside a
cron invocation. Results arrive by pingback.

---

## 10. Auth & dashboard access

Alerting is in-app only, so the dashboard is the entire delivery surface and
needs real auth: clients must see only their own property.

**Auth.js (NextAuth v5), Credentials provider.** You provision accounts manually
per client, which suits an agency with a handful of retainer clients and needs
no email-sending service at all.

1. Generate a secret: `openssl rand -base64 32` → `AUTH_SECRET`.
2. Set `AUTH_URL` to your production origin, **no trailing slash** — the app
   rejects one at startup, because a trailing slash silently breaks every
   callback URL.
3. Passwords are hashed with bcrypt at cost 12. Plaintext is never stored.
4. `role` (`agency_admin` | `agency_member` | `client`) and the permitted
   property list ride in the session token; every query is scoped by it.

### Creating the first login

```bash
pnpm db:migrate
SEED_ADMIN_EMAIL='you@agency.com' SEED_ADMIN_PASSWORD='...' pnpm db:seed
```

Omit `SEED_ADMIN_PASSWORD` and the seed generates one and prints it once.
Re-running the seed never resets an existing password — it would otherwise lock
out an admin who has since changed theirs.

### Access model

| Role | Sees |
|---|---|
| `agency_admin` | Every property in the organisation, plus `/ops` |
| `agency_member` | Every property in the organisation |
| `client` | Only properties explicitly granted in `user_properties` |

To add a client: create the user with role `client`, then insert the
`user_properties` rows granting them specific properties. A `client` with no
grants sees nothing — deliberately fail-closed.

> **Tenancy enforcement.** Queries are scoped in application code through a
> single `forProperty(propertyId)` builder and an `assertPropertyAccess` helper,
> so writing an unscoped query is structurally difficult rather than merely
> discouraged. Add a Postgres row-level security policy on top if you ever
> expose the database directly to anything other than Next.js server code.

### Escalation paths, when you need them

- **Google OAuth** for your own team — free, no consent-screen review for
  internal use, removes agency password management. Add it alongside Credentials.
- **Clerk** free tier (10,000 MAU) for magic links, invitations and org
  management without building them. Adds a vendor.
- **Magic links** need an email sender (Resend's free tier covers 3,000/month).
  You skipped external channels for *alerts*; a login mechanism is a different
  thing, and worth revisiting if manual provisioning gets tedious.

---

## 11. Environment variable reference

Copy `.env.example` to `.env.local` and fill it in. Every value is validated at
startup by `src/lib/env.ts`; a missing or malformed one fails fast with the
variable **name** and the reason — never the value.

| Variable | Source | Notes |
|---|---|---|
| `DATABASE_URL` | Neon, **pooled** string | Runtime queries |
| `DATABASE_URL_UNPOOLED` | Neon, **direct** string | Migrations only |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `client_email` in the service-account JSON | Must be a valid email |
| `GOOGLE_PRIVATE_KEY` | `private_key` in the same JSON | See the newline gotcha below |
| `DATAFORSEO_LOGIN` | Account email | — |
| `DATAFORSEO_PASSWORD` | Dashboard **API** password | Not your login password |
| `DATAFORSEO_PINGBACK_SECRET` | `openssl rand -hex 32` | Validates inbound result webhooks |
| `CRON_SECRET` | `openssl rand -hex 32` | Sent by Vercel cron automatically; also used by the external scheduler |
| `APP_BASE_URL` | Deployment origin | Used to build pingback URLs. No trailing slash |
| `AUTH_SECRET` | `openssl rand -base64 32` | Auth.js session encryption |
| `AUTH_URL` | Deployment origin | Must match exactly. No trailing slash |
| `SEED_ADMIN_EMAIL` | You choose | Optional; the first admin login |
| `SEED_ADMIN_PASSWORD` | You choose | Optional; generated and printed once if omitted |
| `TEST_DATABASE_URL` | Neon `dev` branch | Optional; enables the integration suite |

### The private key newline gotcha

`private_key` in the JSON contains literal `\n` escape sequences. Pasted into a
Vercel environment variable they stay escaped, and the crypto library rejects
the value with a PEM decoding error. This accounts for most first-deploy
failures with Google service accounts.

The app unescapes once, in `src/lib/env.ts`, so no call site has to remember.
Your only job: **wrap the value in double quotes in `.env.local`** so the
escapes survive dotenv parsing.

---

## 12. Pre-flight checklist

Do not start the first paid SERP run until every line is ticked.

- [ ] Google Cloud project created; **Google Search Console API** enabled
- [ ] Service account created; JSON key downloaded and stored in a password manager
- [ ] Service account added as a **Restricted** user on every tracked property
- [ ] `pnpm verify:gsc` call A lists your properties
- [ ] `pnpm verify:gsc` call B returns HTTP 200 with `dataState: "hourly_all"`
- [ ] Exact `siteUrl` recorded per property, trailing slash or `sc-domain:` included
- [ ] DataForSEO account funded ($50 minimum); **API** password copied from the dashboard
- [ ] `pnpm verify:dataforseo` reports a positive balance
- [ ] Live SERP call returns your domain with both `rank_group` and `rank_absolute`
- [ ] Real SERP response committed to `src/test/fixtures/`
- [ ] `location_code` resolved for each target geo and written into `src/server/db/seed-data.ts`
- [ ] Neon project created on **Postgres 17** in an Asia-Pacific region; both strings saved
- [ ] Neon `dev` branch created; `TEST_DATABASE_URL` set
- [ ] `pnpm db:migrate && pnpm db:seed` succeed; `/api/health` returns `"migrated": true`
- [ ] Vercel project imported; all variables set across all three environments
- [ ] Cron strategy chosen (external scheduler on Hobby, or Pro for native cron)
- [ ] `CRON_SECRET`, `AUTH_SECRET`, `DATAFORSEO_PINGBACK_SECRET` generated
- [ ] `.gitignore` covers `.env*` and `*service-account*.json` (it does — verify nothing slipped in with `git status`)

---

## 13. Cost model

**Assumptions:** 10 properties × 10 keywords × 2 devices × 2 geos = 400 tracked
combinations. Search Console polled hourly (free). SERP checks 4× daily on the
standard queue → 1,600 SERPs/day ≈ 48,000/month.

| Item | Monthly | Notes |
|---|---|---|
| Search Console API | **$0** | Free, no billing account |
| DataForSEO, standard queue | **~$28.80** | 48,000 × $0.0006 |
| Neon Postgres | **$0 → ~$19** | Free tier until storage forces Launch |
| Vercel | **$0 → $20** | Hobby + external cron, or Pro |
| **Total** | **~$29 → ~$68** | Plus the one-time $50 DataForSEO deposit |

**Single-property reality check**, which is where you actually start: 13
keywords × 2 targets × 4 checks = 104 SERPs/day ≈ 3,120/month ≈ **$1.87/month**.
The $50 minimum deposit covers roughly two years at that rate.

**Levers if cost matters:**

- Drop to 2 checks/day for stable keywords; reserve frequent checks for the few
  you are actively moving. Halves SERP spend immediately. This is what
  `keyword_targets.check_interval_min` is for.
- Track one geo per keyword unless the divergence is genuinely informative.
- Desktop rarely diverges much from mobile for a mobile-first query set — check
  desktop daily and mobile more often.
- Search Console data is free and unlimited. Poll it aggressively; spend paid
  SERP calls only where you need a true fixed-location rank.

`/ops` shows month-to-date DataForSEO spend against the sum of
`serp_checks.cost_usd`. You are spending real money on a schedule; watch it.

---

## 14. Known gotchas

**Pacific Time date boundaries.** Search Console dates are Pacific Time. IST is
UTC+5:30 and PT is UTC−7/−8, a 12.5–13.5 hour offset, so a GSC "day" straddles
two IST days. The raw PT date is stored exactly as returned and converted only
for display. Do not silently shift dates on ingest; you will never untangle it
afterwards.

**Hourly data is provisional.** `hourly_all` and `all` return partial data that
Google revises. Every such row is stored with `data_state = 'hourly'` and
re-fetched with `dataState: "final"` four days later as a *separate* row. The
provisional value stays queryable — showing how much Google revised a figure is
how you calibrate trust in same-day numbers.

**Average position is not rank.** Search Console gives a click-weighted average
across devices, locations and every impression in the window. DataForSEO gives a
discrete rank at one pinned location and device. Different measurements, not two
attempts at the same one. Every number in the UI is labelled with its source; a
chart mixing them is actively misleading.

**Positions from tiny impression counts are noise.** A keyword with one
impression that day can report position 6.0 and mean nothing. Anything below 3
impressions is excluded from alerts and marked low-confidence in the UI.

**"Not found" is not position 100.** If the domain is absent from the fetched
depth, the row stores `found = false` with null ranks, rendered as a gap or an
"out of range" band. Writing 100 into the position column corrupts every average
computed afterwards.

**The ranking URL changes.** Google may swap which of your pages ranks. The URL
is recorded on every check — a rank that "held steady" while the ranking page
changed underneath is a significant event, not a non-event.

**Multiple URLs can rank for one keyword.** The best `rank_group` becomes the
position; the full set is stored in `all_ranking_urls`.

**Idempotency.** Every snapshot table has a unique constraint on its natural key
and every write uses `ON CONFLICT DO UPDATE`. Cron jobs get retried, external
schedulers double-fire, and you will re-run backfills by hand. Note
`gsc_snapshots` needs `NULLS NOT DISTINCT` for this to actually work — see
`NOTES.md` §1.

**Backfill on property add.** Search Console holds 16 months. It is pulled once
when a property is first connected: free, and it gives a new client an instant
trend line instead of a blank chart.

**Invert the rank axis.** Position 1 is the best value, so a rank chart plots 1
at the top and increases downward. Plotting it the default way produces a graph
where improvement looks like decline — the single most common mistake in
rank-tracking UIs.

**DataForSEO batching.** `task_post` accepts 100 tasks per request. One request
per keyword works but is slow and wasteful.

**Don't scrape Google directly.** Rolling your own scraper gets CAPTCHA'd and
blocked, and violates Google's terms. The whole point of the SERP API line item
is that someone else carries that problem.
