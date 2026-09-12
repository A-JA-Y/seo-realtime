-- API rate-limit windows (§10).
--
-- A table rather than memory: serverless instances are many and short-lived,
-- so an in-memory counter enforces the limit PER INSTANCE and the effective
-- ceiling rises with concurrency — which is backwards, because concurrency is
-- when a limit matters.
--
-- One row per (principal, bucket). The window start MOVES rather than rows
-- accumulating, so the table stays proportional to active callers rather than
-- to requests.
CREATE TABLE "api_rate_limits" (
	"principal_key" text NOT NULL,
	"bucket" text NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "api_rate_limits_principal_key_bucket_pk" PRIMARY KEY("principal_key","bucket")
);
