-- transactions
-- Transaction list for one location and date range (GraphQL: Query.transactions).
--
-- Run with:
--   bq query --use_legacy_sql=false --dataset_id=finns_hospitality \
--     --parameter=location_id::loc-beach-club ... < database/queries/transactions.sql
--
-- The identical text is embedded in gcp-middleware/src/bigquery/queries.ts, and
-- ddl.test.ts fails if the two copies differ, so this file cannot rot into a lie.

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
