ALTER TABLE "keyword_targets" ADD COLUMN "last_enqueued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "keyword_targets" ADD COLUMN "last_live_check_at" timestamp with time zone;