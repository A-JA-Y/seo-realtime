-- Alerts get their own ingest_runs kind.
--
-- The engine writes rows and costs nothing, but it is a scheduled job like any
-- other and /ops has to be able to say when it last ran and whether it failed.
-- Folding it into 'rollup' would make a silent alert engine look like a healthy
-- rollup, which is the failure mode most worth catching: nobody notices alerts
-- that stop arriving.
ALTER TYPE "ingest_kind" ADD VALUE IF NOT EXISTS 'alerts';
