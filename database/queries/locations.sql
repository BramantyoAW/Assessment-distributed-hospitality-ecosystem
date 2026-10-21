-- locations
-- Dimension read: the four countable areas.
--
-- Run with:
--   bq query --use_legacy_sql=false --dataset_id=finns_hospitality \
--     --parameter=location_id::loc-beach-club ... < database/queries/locations.sql
--
-- The identical text is embedded in gcp-middleware/src/bigquery/queries.ts, and
-- ddl.test.ts fails if the two copies differ, so this file cannot rot into a lie.

SELECT
  location_id,
  name,
  area,
  capacity,
  is_outdoor,
  timezone,
  opened_on
FROM dim_location
ORDER BY location_id ASC
