import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
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
    backfilledAt: timestamp('backfilled_at', { withTimezone: true, mode: 'date' }),
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
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true, mode: 'date' }),
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
  ],
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
export const serpPayloads = pgTable('serp_payloads', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  serpCheckId: bigint('serp_check_id', { mode: 'number' })
    .notNull()
    .references(() => serpChecks.id, { onDelete: 'cascade' }),
  payload: jsonb('payload').notNull(),
  createdAt: createdAt(),
});

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
export type AlertType = (typeof alertType.enumValues)[number];
export type AlertSeverity = (typeof alertSeverity.enumValues)[number];
export type IngestKind = (typeof ingestKind.enumValues)[number];
export type IngestStatus = (typeof ingestStatus.enumValues)[number];
