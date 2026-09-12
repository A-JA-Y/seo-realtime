CREATE TYPE "public"."gsc_dimension_mode" AS ENUM('unknown', 'combined', 'per_date');--> statement-breakpoint
CREATE TABLE "gsc_backfill_cursors" (
	"keyword_id" uuid PRIMARY KEY NOT NULL,
	"property_id" uuid NOT NULL,
	"covered_from" date,
	"covered_through" date,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "gsc_dimension_mode" "gsc_dimension_mode" DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "gsc_dimension_probed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gsc_backfill_cursors" ADD CONSTRAINT "gsc_backfill_cursors_keyword_id_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."keywords"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_backfill_cursors" ADD CONSTRAINT "gsc_backfill_cursors_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gsc_backfill_cursors_property" ON "gsc_backfill_cursors" USING btree ("property_id","completed_at");--> statement-breakpoint
ALTER TABLE "gsc_snapshots" ADD CONSTRAINT "gsc_snapshots_no_position_without_impressions" CHECK (impressions > 0 OR position IS NULL);--> statement-breakpoint
ALTER TABLE "gsc_snapshots" ADD CONSTRAINT "gsc_snapshots_position_range" CHECK (position IS NULL OR position >= 1);--> statement-breakpoint
ALTER TABLE "gsc_snapshots" ADD CONSTRAINT "gsc_snapshots_counts_nonnegative" CHECK (clicks >= 0 AND impressions >= 0);--> statement-breakpoint
ALTER TABLE "gsc_snapshots" ADD CONSTRAINT "gsc_snapshots_hour_range" CHECK (gsc_hour IS NULL OR (gsc_hour >= 0 AND gsc_hour <= 23));--> statement-breakpoint
ALTER TABLE "gsc_snapshots" ADD CONSTRAINT "gsc_snapshots_hour_matches_state" CHECK ((data_state = 'hourly') = (gsc_hour IS NOT NULL));