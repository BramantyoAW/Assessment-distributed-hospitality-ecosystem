/**
 * Every SQL statement the service and the job run.
 *
 * Kept as exported constants rather than strings inside resolves so that
 * `database/queries/*.sql` can hold the identical text for manual verification
 * (`ddl.test.ts` asserts they match after whitespace normalisation). If the two
 * copies could drift, the documented command would stop proving anything.
 *
 * All statements read the dedupe views, never the base tables, and all of them
 * use unqualified names so the caller's default dataset decides the target. That
 * keeps the files runnable from `bq query --dataset_id=finns_hospitality`.
 *
 * Only `@name` bind parameters are used. The two exceptions are `bucket` in
 * `VISITOR_COUNTS_DDL` and the range literal in the date dimension, and both are
 * whitelisted literals, never user input: BigQuery cannot bind a DATE_PART.
 */

import type { VisitBucket } from './gateway.js';

export const LOCATIONS_SQL = `
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
`;

export const TRANSACTIONS_SQL = `
SELECT
  transaction_id,
  location_id,
  business_date,
  occurred_at,
  occurred_at_source,
  source_created_at,
  source_modified_at,
  amount,
  currency,
  txn_type,
  guests,
  source_system,
  ingested_at
FROM vw_fact_transactions
WHERE location_id = @location_id
  AND business_date BETWEEN @from_date AND @to_date
ORDER BY business_date DESC, transaction_id ASC
LIMIT @row_limit
`;

const VISITOR_COUNTS_DDL = (bucket: VisitBucket): string => `
WITH readings AS (
  SELECT
    location_id,
    event_id,
    people_count,
    interval_seconds,
    TIMESTAMP_TRUNC(observed_at, ${bucket}, 'Asia/Makassar') AS bucket_start
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
`;

export const VISITOR_COUNTS_HOUR_SQL = VISITOR_COUNTS_DDL('HOUR');
export const VISITOR_COUNTS_DAY_SQL = VISITOR_COUNTS_DDL('DAY');

export function visitorCountsSql(bucket: VisitBucket): string {
  return bucket === 'DAY' ? VISITOR_COUNTS_DAY_SQL : VISITOR_COUNTS_HOUR_SQL;
}

/**
 * Aggregate each fact first, then join.
 *
 * The tempting version joins the two fact tables on (location, date) and then
 * aggregates, which multiplies each transaction by the number of camera readings
 * for that day. With 3 transactions (100/200/300) and 2 readings (10/15) the
 * naive join reports 0.04 conversion instead of 0.12, revenue 1200 instead of
 * 600, and 75 visits instead of 25. Every number is wrong and none of them looks
 * wrong. `conversion.test.ts` pins the correct triple.
 *
 * Keys arrive as two parallel arrays zipped by offset: a STRUCT array parameter
 * would work, but two ARRAY<STRING> / ARRAY<DATE> parameters are far easier to
 * build and to read in a log.
 *
 * The gateway de-duplicates the key list before binding it. Without that, a
 * repeated key would join the facts twice and `SUM(amount)` would double-count
 * revenue even though `COUNT(DISTINCT …)` looks correct.
 */
export const CONVERSION_METRICS_SQL = `
WITH keys AS (
  SELECT location_id, business_date
  FROM UNNEST(@location_ids) AS location_id WITH OFFSET AS pos
  JOIN UNNEST(@business_dates) AS business_date WITH OFFSET AS pos2
    ON pos = pos2
),
txn AS (
  SELECT
    k.location_id,
    k.business_date,
    COUNT(DISTINCT f.transaction_id) AS total_transactions,
    SUM(f.amount)                    AS total_revenue
  FROM keys AS k
  JOIN vw_fact_transactions AS f USING (location_id, business_date)
  GROUP BY k.location_id, k.business_date
),
visits AS (
  SELECT
    k.location_id,
    k.business_date,
    SUM(f.people_count)      AS total_visits,
    COUNT(DISTINCT f.event_id) AS total_readings,
    SUM(f.interval_seconds)  AS camera_seconds
  FROM keys AS k
  JOIN vw_fact_camera_events AS f USING (location_id, business_date)
  GROUP BY k.location_id, k.business_date
)
SELECT
  k.location_id,
  k.business_date,
  COALESCE(t.total_transactions, 0)            AS total_transactions,
  COALESCE(t.total_revenue, NUMERIC '0')       AS total_revenue,
  COALESCE(v.total_visits, 0)                  AS total_visits,
  COALESCE(v.total_readings, 0)                AS total_readings,
  COALESCE(v.camera_seconds, 0)                AS camera_seconds,
  SAFE_DIVIDE(t.total_transactions, v.total_visits) AS conversion_rate
FROM keys AS k
LEFT JOIN txn    AS t USING (location_id, business_date)
LEFT JOIN visits AS v USING (location_id, business_date)
ORDER BY k.location_id ASC, k.business_date ASC
`;

export const CHECKPOINT_LATEST_SQL = `
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
`;
