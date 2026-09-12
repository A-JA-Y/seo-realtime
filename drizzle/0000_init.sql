CREATE TYPE "public"."alert_severity" AS ENUM('info', 'warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."alert_type" AS ENUM('rank_drop', 'rank_gain', 'lost_top_10', 'entered_top_10', 'lost_from_index', 'ranking_url_changed', 'new_competitor_top_3', 'ingest_failure');--> statement-breakpoint
CREATE TYPE "public"."device_type" AS ENUM('desktop', 'mobile');--> statement-breakpoint
CREATE TYPE "public"."gsc_data_state" AS ENUM('hourly', 'fresh', 'final');--> statement-breakpoint
CREATE TYPE "public"."gsc_property_type" AS ENUM('url_prefix', 'domain');--> statement-breakpoint
CREATE TYPE "public"."ingest_kind" AS ENUM('gsc_hourly', 'gsc_reconcile', 'gsc_backfill', 'serp_batch', 'rollup', 'prune');--> statement-breakpoint
CREATE TYPE "public"."ingest_status" AS ENUM('running', 'success', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('agency_admin', 'agency_member', 'client');--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"keyword_id" uuid,
	"keyword_target_id" uuid,
	"type" "alert_type" NOT NULL,
	"severity" "alert_severity" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "daily_rank_rollups" (
	"keyword_target_id" uuid NOT NULL,
	"day" date NOT NULL,
	"best_rank_group" integer,
	"worst_rank_group" integer,
	"avg_rank_group" numeric(6, 2),
	"best_rank_absolute" integer,
	"avg_rank_absolute" numeric(6, 2),
	"checks_count" integer NOT NULL,
	"found_count" integer NOT NULL,
	CONSTRAINT "daily_rank_rollups_keyword_target_id_day_pk" PRIMARY KEY("keyword_target_id","day")
);
--> statement-breakpoint
CREATE TABLE "gsc_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"property_id" uuid NOT NULL,
	"keyword_id" uuid NOT NULL,
	"gsc_date" date NOT NULL,
	"gsc_hour" smallint,
	"data_state" "gsc_data_state" NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"ctr" numeric(7, 6) DEFAULT '0' NOT NULL,
	"position" numeric(6, 2),
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gsc_snapshots_natural_key" UNIQUE NULLS NOT DISTINCT("keyword_id","gsc_date","gsc_hour","data_state")
);
--> statement-breakpoint
CREATE TABLE "ingest_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "ingest_kind" NOT NULL,
	"property_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "ingest_status" DEFAULT 'running' NOT NULL,
	"rows_written" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"error" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "keyword_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"keyword_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"location_code" integer NOT NULL,
	"location_name" text NOT NULL,
	"language_code" text DEFAULT 'en' NOT NULL,
	"device" "device_type" NOT NULL,
	"check_interval_min" integer DEFAULT 360 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "keyword_targets_natural_key" UNIQUE("keyword_id","location_code","device","language_code")
);
--> statement-breakpoint
CREATE TABLE "keywords" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"term" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "keywords_property_term_key" UNIQUE("property_id","term")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"domain" text NOT NULL,
	"gsc_site_url" text NOT NULL,
	"gsc_property_type" "gsc_property_type" NOT NULL,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"backfilled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "properties_org_site_url_key" UNIQUE("org_id","gsc_site_url")
);
--> statement-breakpoint
CREATE TABLE "serp_checks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"keyword_target_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"keyword_id" uuid NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"found" boolean NOT NULL,
	"rank_group" integer,
	"rank_absolute" integer,
	"ranking_url" text,
	"all_ranking_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"competing_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"serp_features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"organic_result_count" integer,
	"search_depth" integer DEFAULT 100 NOT NULL,
	"provider" text DEFAULT 'dataforseo' NOT NULL,
	"provider_task_id" text,
	"cost_usd" numeric(10, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "serp_checks_natural_key" UNIQUE("keyword_target_id","checked_at")
);
--> statement-breakpoint
CREATE TABLE "serp_payloads" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"serp_check_id" bigint NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_properties" (
	"user_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	CONSTRAINT "user_properties_user_id_property_id_pk" PRIMARY KEY("user_id","property_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text,
	"role" "user_role" DEFAULT 'client' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_keyword_id_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."keywords"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_keyword_target_id_keyword_targets_id_fk" FOREIGN KEY ("keyword_target_id") REFERENCES "public"."keyword_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_rank_rollups" ADD CONSTRAINT "daily_rank_rollups_keyword_target_id_keyword_targets_id_fk" FOREIGN KEY ("keyword_target_id") REFERENCES "public"."keyword_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_snapshots" ADD CONSTRAINT "gsc_snapshots_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_snapshots" ADD CONSTRAINT "gsc_snapshots_keyword_id_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."keywords"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_runs" ADD CONSTRAINT "ingest_runs_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keyword_targets" ADD CONSTRAINT "keyword_targets_keyword_id_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."keywords"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keyword_targets" ADD CONSTRAINT "keyword_targets_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keywords" ADD CONSTRAINT "keywords_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serp_checks" ADD CONSTRAINT "serp_checks_keyword_target_id_keyword_targets_id_fk" FOREIGN KEY ("keyword_target_id") REFERENCES "public"."keyword_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serp_checks" ADD CONSTRAINT "serp_checks_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serp_checks" ADD CONSTRAINT "serp_checks_keyword_id_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."keywords"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serp_payloads" ADD CONSTRAINT "serp_payloads_serp_check_id_serp_checks_id_fk" FOREIGN KEY ("serp_check_id") REFERENCES "public"."serp_checks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_properties" ADD CONSTRAINT "user_properties_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_properties" ADD CONSTRAINT "user_properties_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_open_signature" ON "alerts" USING btree ("signature") WHERE resolved_at IS NULL;--> statement-breakpoint
CREATE INDEX "alerts_feed" ON "alerts" USING btree ("property_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "gsc_snapshots_lookup" ON "gsc_snapshots" USING btree ("keyword_id","gsc_date" DESC NULLS LAST,"data_state");--> statement-breakpoint
CREATE INDEX "ingest_runs_recent" ON "ingest_runs" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "serp_checks_lookup" ON "serp_checks" USING btree ("keyword_target_id","checked_at" DESC NULLS LAST);