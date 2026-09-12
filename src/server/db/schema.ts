import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/* ══════════════════════════════════════════════════════════════════════════
   Shared column helpers
   ══════════════════════════════════════════════════════════════════════════ */

const pk = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();

/* ══════════════════════════════════════════════════════════════════════════
   Enums
   ══════════════════════════════════════════════════════════════════════════ */

export const userRole = pgEnum('user_role', ['agency_admin', 'agency_member', 'client']);
export const gscPropertyType = pgEnum('gsc_property_type', ['url_prefix', 'domain']);
export const deviceType = pgEnum('device_type', ['desktop', 'mobile']);

/**
 * Which request shape this property's Search Console data accepts.
 *
 * Google's reference confirms `date` and `hour` are both valid dimensions but
 * does NOT document whether they may be combined in one request. §5 requires
 * probing it once and caching the answer — "do not retry the failing shape
 * every hour". Every cron invocation is a cold serverless process, so an
 * in-memory memo would cache nothing; the answer has to be durable.
 *
 * Scoped per property rather than globally: the capability is probably uniform
 * across the API, but assuming so and being wrong means one property silently
 * stops ingesting, while assuming per-property and being wrong costs one
 * redundant probe per property, once.
 */
export const gscDimensionMode = pgEnum('gsc_dimension_mode', ['unknown', 'combined', 'per_date']);

/**
 * Provisional → finalised lifecycle of a Search Console figure.
 * Read precedence is final > fresh > hourly and lives in exactly one function
 * (`getGscSeries`), never inlined at a call site.
 */
export const gscDataState = pgEnum('gsc_data_state', ['hourly', 'fresh', 'final']);

export const alertType = pgEnum('alert_type', [
  'rank_drop',
  'rank_gain',
  'lost_top_10',
  'entered_top_10',
  'lost_from_index',
  'ranking_url_changed',
  'new_competitor_top_3',
  'ingest_failure',
]);

export const alertSeverity = pgEnum('alert_severity', ['info', 'warning', 'critical']);

export const ingestKind = pgEnum('ingest_kind', [
  'gsc_hourly',
  'gsc_reconcile',
  'gsc_backfill',
  'serp_batch',
  'rollup',
  'prune',
  'alerts',
]);

export const ingestStatus = pgEnum('ingest_status', ['running', 'success', 'partial', 'failed']);

/* ══════════════════════════════════════════════════════════════════════════
   Tenancy
   ══════════════════════════════════════════════════════════════════════════ */

export const organizations = pgTable('organizations', {
  id: pk(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  createdAt: createdAt(),
});

export const users = pgTable('users', {
  id: pk(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name'),
  role: userRole('role').notNull().default('client'),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),
  createdAt: createdAt(),
});

export const properties = pgTable(
  'properties',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Registrable host only — no scheme, no trailing slash. 'example.com'. */
    domain: text('domain').notNull(),
    /**
     * The exact Search Console identifier. URL-prefix properties keep their
     * trailing slash; domain properties keep the `sc-domain:` prefix. A
     * mismatch here surfaces as a 403 that looks like a permissions problem.
     */
    gscSiteUrl: text('gsc_site_url').notNull(),
    gscPropertyType: gscPropertyType('gsc_property_type').notNull(),
    /** Presentation timezone. Ingestion never converts; see domain rule 4. */
    timezone: text('timezone').notNull().default('Asia/Kolkata'),
    isActive: boolean('is_active').notNull().default(true),
    /** Set once every keyword's backfill has reached the 16-month floor. */
    backfilledAt: timestamp('backfilled_at', { withTimezone: true, mode: 'date' }),
    /** Cached answer to the date+hour dimension probe. See gscDimensionMode. */
    gscDimensionMode: gscDimensionMode('gsc_dimension_mode').notNull().default('unknown'),
    /**
     * When the probe last ran. A `per_date` answer is re-probed occasionally so
     * a downgrade is not permanent if Google starts accepting the combined
     * shape — but not every hour, which is what §5 forbids.
     */
    gscDimensionProbedAt: timestamp('gsc_dimension_probed_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (t) => [unique('properties_org_site_url_key').on(t.orgId, t.gscSiteUrl)],
);

/**
 * Explicit grant table so a `client` user can be scoped to a subset of their
 * organisation's properties. Agency roles ignore this and see the whole org.
 */
export const userProperties = pgTable(
  'user_properties',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.propertyId] })],
);

/* ══════════════════════════════════════════════════════════════════════════
   Tracking configuration
   ══════════════════════════════════════════════════════════════════════════ */

export const keywords = pgTable(
  'keywords',
  {
    id: pk(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    term: text('term').notNull(),
    /** Money keywords. Checked more often and used for the overview averages. */
    isPrimary: boolean('is_primary').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [unique('keywords_property_term_key').on(t.propertyId, t.term)],
);

/** One row per keyword × location × device. The unit that gets SERP-checked. */
export const keywordTargets = pgTable(
  'keyword_targets',
  {
    id: pk(),
    keywordId: uuid('keyword_id')
      .notNull()
      .references(() => keywords.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    /** Resolved from /v3/serp/google/locations. Never hardcoded. */
    locationCode: integer('location_code').notNull(),
    locationName: text('location_name').notNull(),
    languageCode: text('language_code').notNull().default('en'),
    device: deviceType('device').notNull(),
    checkIntervalMin: integer('check_interval_min').notNull().default(360),
    isActive: boolean('is_active').notNull().default(true),
    /** When a RESULT last landed. Advanced by the pingback, not by submission. */
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true, mode: 'date' }),
    /**
     * When this target was last SUBMITTED to the provider.
     *
     * Separate from `last_checked_at` because submission is what costs money
     * and a result may never arrive. Without it, a target whose pingback is
     * lost — a failed task, a misconfigured webhook — stays permanently "due"
     * and is re-submitted and re-billed on every single run, forever, with
     * nothing to show for it.
     */
    lastEnqueuedAt: timestamp('last_enqueued_at', { withTimezone: true, mode: 'date' }),
    /**
     * When a LIVE check-now last ran for this target.
     *
     * Its own column so the cooldown can be claimed atomically in one
     * conditional UPDATE. Deriving it from `serp_checks` makes the check a
     * read-then-act race, and two simultaneous button presses both pay.
     */
    lastLiveCheckAt: timestamp('last_live_check_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('keyword_targets_natural_key').on(
      t.keywordId,
      t.locationCode,
      t.device,
      t.languageCode,
    ),
  ],
);

/* ══════════════════════════════════════════════════════════════════════════
   Search Console data
   ══════════════════════════════════════════════════════════════════════════ */

export const gscSnapshots = pgTable(
  'gsc_snapshots',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    keywordId: uuid('keyword_id')
      .notNull()
      .references(() => keywords.id, { onDelete: 'cascade' }),
    /**
     * Pacific Time, stored as the API returned it. `mode: 'string'` is load
     * bearing — a JS Date here would let a local-timezone round trip shift the
     * day, which domain rule 4 forbids.
     */
    gscDate: date('gsc_date', { mode: 'string' }).notNull(),
    /** 0–23 for hourly rows, NULL for daily rows. */
    gscHour: smallint('gsc_hour'),
    dataState: gscDataState('data_state').notNull(),
    clicks: integer('clicks').notNull().default(0),
    impressions: integer('impressions').notNull().default(0),
    ctr: numeric('ctr', { precision: 7, scale: 6 }).notNull().default('0'),
    /** NULL when impressions = 0. Never 0, never a sentinel. */
    position: numeric('position', { precision: 6, scale: 2 }),
    fetchedAt: timestamp('fetched_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    /*
     * NULLS NOT DISTINCT is required, not cosmetic. `gsc_hour` is NULL on every
     * daily row, and Postgres treats NULLs in a unique constraint as distinct
     * by default — so a plain UNIQUE would never fire for `fresh`/`final` rows
     * and `ON CONFLICT DO UPDATE` would silently insert duplicates on every
     * reconcile re-run. See NOTES.md §1.
     */
    unique('gsc_snapshots_natural_key')
      .on(t.keywordId, t.gscDate, t.gscHour, t.dataState)
      .nullsNotDistinct(),
    index('gsc_snapshots_lookup').on(t.keywordId, t.gscDate.desc(), t.dataState),

    /*
     * The storage invariants, enforced by the database rather than by comments.
     *
     * These are the rules the read resolver would otherwise have to detect and
     * report at runtime. Enforcing them here makes the violating rows
     * unstorable, which turns a class of silent wrong answers into a loud write
     * failure at the point the bad data was produced.
     */

    // Domain rule 5's principle, applied to Search Console: no impressions
    // means no position. Never a zero, never a sentinel.
    check('gsc_snapshots_no_position_without_impressions', sql`impressions > 0 OR position IS NULL`),

    // Position 0 does not exist. A 0 here would render above position 1 on an
    // inverted axis — better than first place.
    check('gsc_snapshots_position_range', sql`position IS NULL OR position >= 1`),

    check('gsc_snapshots_counts_nonnegative', sql`clicks >= 0 AND impressions >= 0`),

    // `gsc_hour` is a Pacific clock LABEL, not an elapsed hour. The 25-hour
    // fall-back day still only has labels 0-23.
    check('gsc_snapshots_hour_range', sql`gsc_hour IS NULL OR (gsc_hour >= 0 AND gsc_hour <= 23)`),

    // An hourly row has an hour; a daily row does not. This biconditional is
    // what makes the read resolver total — with it, "which rows are the daily
    // candidate" has exactly one answer.
    check(
      'gsc_snapshots_hour_matches_state',
      sql`(data_state = 'hourly') = (gsc_hour IS NOT NULL)`,
    ),
  ],
);

/**
 * Per-keyword backfill progress.
 *
 * Search Console holds 16 months, walked backwards in 3-month windows. The job
 * must be resumable, and progress cannot be derived from `gsc_snapshots`: that
 * table is a log of POSITIVE observations, and Google omits dates with no
 * impressions entirely. A quiet window writes no rows, so `MIN(gsc_date)` would
 * not advance and the walk would either loop or redo work forever.
 *
 * Keyed per keyword rather than per property for a second reason: a keyword
 * added to an already-backfilled property still needs its own history. A
 * property-level "done" flag would leave it permanently blank.
 */
export const gscBackfillCursors = pgTable(
  'gsc_backfill_cursors',
  {
    keywordId: uuid('keyword_id')
      .primaryKey()
      .references(() => keywords.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    /** Earliest date attempted so far. The walk continues backwards from here. */
    coveredFrom: date('covered_from', { mode: 'string' }),
    /** Latest date attempted. Where the first window started. */
    coveredThrough: date('covered_through', { mode: 'string' }),
    /** Set when the walk reaches the 16-month retention floor. */
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('gsc_backfill_cursors_property').on(t.propertyId, t.completedAt)],
);

/* ══════════════════════════════════════════════════════════════════════════
   SERP data
   ══════════════════════════════════════════════════════════════════════════ */

export const serpChecks = pgTable(
  'serp_checks',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    keywordTargetId: uuid('keyword_target_id')
      .notNull()
      .references(() => keywordTargets.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    keywordId: uuid('keyword_id')
      .notNull()
      .references(() => keywords.id, { onDelete: 'cascade' }),
    checkedAt: timestamp('checked_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** False means "absent from the fetched depth". Ranks stay NULL. */
    found: boolean('found').notNull(),
    /** Organic-only position — "which blue link am I". NULL when not found. */
    rankGroup: integer('rank_group'),
    /** All-elements position — reconciles with GSC average. NULL when not found. */
    rankAbsolute: integer('rank_absolute'),
    rankingUrl: text('ranking_url'),
    /** Every one of our URLs that ranked: [{ rank_group, url }]. */
    allRankingUrls: jsonb('all_ranking_urls')
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Top 10 competitors: [{ rank_group, domain, url, title }]. */
    competingDomains: jsonb('competing_domains')
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** { ai_overview, local_pack, images, people_also_ask, video, top_stories, paid_count }. */
    serpFeatures: jsonb('serp_features')
      .notNull()
      .default(sql`'{}'::jsonb`),
    organicResultCount: integer('organic_result_count'),
    searchDepth: integer('search_depth').notNull().default(100),
    provider: text('provider').notNull().default('dataforseo'),
    providerTaskId: text('provider_task_id'),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('serp_checks_natural_key').on(t.keywordTargetId, t.checkedAt),
    index('serp_checks_lookup').on(t.keywordTargetId, t.checkedAt.desc()),
  ],
);

/** Raw payloads live apart so retention can prune them without touching the series. */
export const serpPayloads = pgTable(
  'serp_payloads',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    serpCheckId: bigint('serp_check_id', { mode: 'number' })
      .notNull()
      .references(() => serpChecks.id, { onDelete: 'cascade' }),
    payload: jsonb('payload').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    /*
     * Exactly one payload per check, enforced rather than intended.
     *
     * The write path has no transaction to work with (the Neon HTTP driver has
     * none), so a delete-then-insert races: two concurrent pingback
     * redeliveries for the same task both find nothing to delete and both
     * insert. This turns that into a conflict the upsert resolves.
     */
    unique('serp_payloads_one_per_check').on(t.serpCheckId),
  ],
);

/* ══════════════════════════════════════════════════════════════════════════
   Rollups (storage control)
   ══════════════════════════════════════════════════════════════════════════ */

export const dailyRankRollups = pgTable(
  'daily_rank_rollups',
  {
    keywordTargetId: uuid('keyword_target_id')
      .notNull()
      .references(() => keywordTargets.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    bestRankGroup: integer('best_rank_group'),
    worstRankGroup: integer('worst_rank_group'),
    avgRankGroup: numeric('avg_rank_group', { precision: 6, scale: 2 }),
    bestRankAbsolute: integer('best_rank_absolute'),
    avgRankAbsolute: numeric('avg_rank_absolute', { precision: 6, scale: 2 }),
    checksCount: integer('checks_count').notNull(),
    /** Checks in which we were found. `checks_count - found_count` were misses. */
    foundCount: integer('found_count').notNull(),
  },
  (t) => [primaryKey({ columns: [t.keywordTargetId, t.day] })],
);

/* ══════════════════════════════════════════════════════════════════════════
   Alerts (in-app only — no external delivery channel exists by design)
   ══════════════════════════════════════════════════════════════════════════ */

export const alerts = pgTable(
  'alerts',
  {
    id: pk(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    keywordId: uuid('keyword_id').references(() => keywords.id, { onDelete: 'cascade' }),
    keywordTargetId: uuid('keyword_target_id').references(() => keywordTargets.id, {
      onDelete: 'cascade',
    }),
    type: alertType('type').notNull(),
    severity: alertSeverity('severity').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** sha256(type + keyword_target_id + bucket). See §9. */
    signature: text('signature').notNull(),
    createdAt: createdAt(),
    readAt: timestamp('read_at', { withTimezone: true, mode: 'date' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    /*
     * Partial unique index: at most one OPEN alert per signature. Re-firing the
     * same condition becomes a no-op insert; resolving one frees the signature
     * so a genuine recurrence can raise a fresh alert.
     */
    uniqueIndex('alerts_open_signature')
      .on(t.signature)
      .where(sql`resolved_at IS NULL`),
    index('alerts_feed').on(t.propertyId, t.createdAt.desc()),
  ],
);

/* ══════════════════════════════════════════════════════════════════════════
   Operations
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * API rate-limit windows (§10).
 *
 * In a table, not in memory. Serverless instances are many and short-lived, so
 * an in-memory counter enforces the limit PER INSTANCE — the effective ceiling
 * rises with concurrency, which is exactly backwards.
 *
 * One row per (principal, bucket); the window start moves rather than rows
 * accumulating, so the table stays proportional to active callers rather than
 * to requests.
 */
export const apiRateLimits = pgTable(
  'api_rate_limits',
  {
    /** User id, or an anonymous marker. Never an email — this table is joined in logs. */
    principalKey: text('principal_key').notNull(),
    /** Which limit: the route family, not the exact path. */
    bucket: text('bucket').notNull(),
    windowStartedAt: timestamp('window_started_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    hits: integer('hits').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.principalKey, t.bucket] })],
);

export const ingestRuns = pgTable(
  'ingest_runs',
  {
    id: pk(),
    kind: ingestKind('kind').notNull(),
    propertyId: uuid('property_id').references(() => properties.id, { onDelete: 'set null' }),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    status: ingestStatus('status').notNull().default('running'),
    rowsWritten: integer('rows_written').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).notNull().default('0'),
    error: text('error'),
    meta: jsonb('meta')
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t) => [index('ingest_runs_recent').on(t.startedAt.desc())],
);

/* ══════════════════════════════════════════════════════════════════════════
   Relations
   ══════════════════════════════════════════════════════════════════════════ */

export const organizationsRelations = relations(organizations, ({ many }) => ({
  users: many(users),
  properties: many(properties),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [users.orgId],
    references: [organizations.id],
  }),
  grants: many(userProperties),
}));

export const propertiesRelations = relations(properties, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [properties.orgId],
    references: [organizations.id],
  }),
  keywords: many(keywords),
  grants: many(userProperties),
}));

export const userPropertiesRelations = relations(userProperties, ({ one }) => ({
  user: one(users, { fields: [userProperties.userId], references: [users.id] }),
  property: one(properties, {
    fields: [userProperties.propertyId],
    references: [properties.id],
  }),
}));

export const keywordsRelations = relations(keywords, ({ one, many }) => ({
  property: one(properties, {
    fields: [keywords.propertyId],
    references: [properties.id],
  }),
  targets: many(keywordTargets),
  gscSnapshots: many(gscSnapshots),
}));

export const keywordTargetsRelations = relations(keywordTargets, ({ one, many }) => ({
  keyword: one(keywords, {
    fields: [keywordTargets.keywordId],
    references: [keywords.id],
  }),
  property: one(properties, {
    fields: [keywordTargets.propertyId],
    references: [properties.id],
  }),
  checks: many(serpChecks),
  rollups: many(dailyRankRollups),
}));

export const gscBackfillCursorsRelations = relations(gscBackfillCursors, ({ one }) => ({
  keyword: one(keywords, {
    fields: [gscBackfillCursors.keywordId],
    references: [keywords.id],
  }),
  property: one(properties, {
    fields: [gscBackfillCursors.propertyId],
    references: [properties.id],
  }),
}));

export const gscSnapshotsRelations = relations(gscSnapshots, ({ one }) => ({
  keyword: one(keywords, {
    fields: [gscSnapshots.keywordId],
    references: [keywords.id],
  }),
  property: one(properties, {
    fields: [gscSnapshots.propertyId],
    references: [properties.id],
  }),
}));

export const serpChecksRelations = relations(serpChecks, ({ one, many }) => ({
  target: one(keywordTargets, {
    fields: [serpChecks.keywordTargetId],
    references: [keywordTargets.id],
  }),
  keyword: one(keywords, {
    fields: [serpChecks.keywordId],
    references: [keywords.id],
  }),
  payloads: many(serpPayloads),
}));

export const serpPayloadsRelations = relations(serpPayloads, ({ one }) => ({
  check: one(serpChecks, {
    fields: [serpPayloads.serpCheckId],
    references: [serpChecks.id],
  }),
}));

export const dailyRankRollupsRelations = relations(dailyRankRollups, ({ one }) => ({
  target: one(keywordTargets, {
    fields: [dailyRankRollups.keywordTargetId],
    references: [keywordTargets.id],
  }),
}));

export const alertsRelations = relations(alerts, ({ one }) => ({
  property: one(properties, {
    fields: [alerts.propertyId],
    references: [properties.id],
  }),
  keyword: one(keywords, { fields: [alerts.keywordId], references: [keywords.id] }),
  target: one(keywordTargets, {
    fields: [alerts.keywordTargetId],
    references: [keywordTargets.id],
  }),
}));

/* ══════════════════════════════════════════════════════════════════════════
   Inferred types
   ══════════════════════════════════════════════════════════════════════════ */

export type Organization = typeof organizations.$inferSelect;
export type User = typeof users.$inferSelect;
export type Property = typeof properties.$inferSelect;
export type Keyword = typeof keywords.$inferSelect;
export type KeywordTarget = typeof keywordTargets.$inferSelect;
export type GscSnapshot = typeof gscSnapshots.$inferSelect;
export type GscBackfillCursor = typeof gscBackfillCursors.$inferSelect;
export type SerpCheck = typeof serpChecks.$inferSelect;
export type DailyRankRollup = typeof dailyRankRollups.$inferSelect;
export type Alert = typeof alerts.$inferSelect;
export type IngestRun = typeof ingestRuns.$inferSelect;

export type NewGscSnapshot = typeof gscSnapshots.$inferInsert;
export type NewSerpCheck = typeof serpChecks.$inferInsert;
export type NewAlert = typeof alerts.$inferInsert;
export type NewIngestRun = typeof ingestRuns.$inferInsert;

export type UserRole = (typeof userRole.enumValues)[number];
export type DeviceType = (typeof deviceType.enumValues)[number];
export type GscDataState = (typeof gscDataState.enumValues)[number];
export type GscDimensionMode = (typeof gscDimensionMode.enumValues)[number];
export type AlertType = (typeof alertType.enumValues)[number];
export type AlertSeverity = (typeof alertSeverity.enumValues)[number];
export type IngestKind = (typeof ingestKind.enumValues)[number];
export type IngestStatus = (typeof ingestStatus.enumValues)[number];
