-- conversion_metrics
-- Transactions and visits aggregated separately, then joined: conversion rate per location-day.
--
-- Run with:
--   bq query --use_legacy_sql=false --dataset_id=finns_hospitality \
--     --parameter=location_id::loc-beach-club ... < database/queries/conversion_metrics.sql
--
-- The identical text is embedded in gcp-middleware/src/bigquery/queries.ts, and
-- ddl.test.ts fails if the two copies differ, so this file cannot rot into a lie.

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
