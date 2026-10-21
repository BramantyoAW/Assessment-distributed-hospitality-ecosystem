-- visitor_counts
-- Camera readings aggregated per hour (GraphQL: Query.visitorCounts, bucket=HOUR).
--
-- Run with:
--   bq query --use_legacy_sql=false --dataset_id=finns_hospitality \
--     --parameter=location_id::loc-beach-club ... < database/queries/visitor_counts.sql
--
-- The identical text is embedded in gcp-middleware/src/bigquery/queries.ts, and
-- ddl.test.ts fails if the two copies differ, so this file cannot rot into a lie.

WITH readings AS (
  SELECT
    location_id,
    event_id,
    people_count,
    interval_seconds,
    TIMESTAMP_TRUNC(observed_at, HOUR, 'Asia/Makassar') AS bucket_start
  FROM vw_fact_camera_events
  WHERE location_id = @location_id
    AND business_date BETWEEN @from_date AND @to_date
)
SELECT
  location_id,
  bucket_start,
  SUM(people_count)    AS visits,
  COUNT(DISTINCT event_id) AS readings,
  SUM(interval_seconds) AS camera_seconds
FROM readings
GROUP BY location_id, bucket_start
ORDER BY bucket_start ASC
LIMIT @row_limit
