-- ingest_checkpoint_latest
-- Newest ingest cursor for one stream.
--
-- Run with:
--   bq query --use_legacy_sql=false --dataset_id=finns_hospitality \
--     --parameter=location_id::loc-beach-club ... < database/queries/ingest_checkpoint_latest.sql
--
-- The identical text is embedded in gcp-middleware/src/bigquery/queries.ts, and
-- ddl.test.ts fails if the two copies differ, so this file cannot rot into a lie.

SELECT
  stream,
  cursor_modified_at,
  cursor_id,
  overlap_minutes,
  run_started_at,
  pages,
  rows_loaded,
  rows_rejected,
  written_at
FROM ingest_checkpoint
WHERE stream = @stream
ORDER BY written_at DESC
LIMIT 1
