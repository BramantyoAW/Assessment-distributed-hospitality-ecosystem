-- Fact: hotel transactions (Revenue Center -> Opera PMS -> warehouse).
--
-- `transaction_id` is the primary key, and it is also the dedupe key. The
-- PRIMARY KEY is NOT ENFORCED: BigQuery never rejects a duplicate, so the
-- guarantee has to come from the load job (WRITE_APPEND + at-least-once) plus
-- the `vw_fact_transactions` view. Writing `PRIMARY KEY ... NOT ENFORCED` and
-- believing it deduplicates is the single easiest way to double-count revenue.
--
-- Partitioned by `business_date`, which is derived at ingest from `trandate`
-- (a date, no timezone conversion). Clustering by `location_id` because every
-- analytical query filters on it first.
--
-- `occurred_at` is nullable on purpose: a source row without a usable time must
-- still load. `occurred_at_source` records whether the value came from the
-- record or was unavailable, so a NULL is explainable instead of mysterious.

CREATE TABLE IF NOT EXISTS finns_hospitality.fact_transactions (
  transaction_id     STRING    NOT NULL,
  location_id        STRING    NOT NULL,
  business_date      DATE      NOT NULL,
  occurred_at        TIMESTAMP,
  occurred_at_source STRING    NOT NULL,   -- record | unavailable | imputed (reserved)
  source_created_at  TIMESTAMP NOT NULL,
  source_modified_at TIMESTAMP NOT NULL,
  amount             NUMERIC   NOT NULL,   -- NUMERIC, never FLOAT64: money
  currency           STRING    NOT NULL,
  txn_type           STRING    NOT NULL,   -- room | fnb | spa | retail | other
  guests             INT64,                -- nullable: not every source row has it
  source_system      STRING    NOT NULL,
  ingested_at        TIMESTAMP NOT NULL,
  PRIMARY KEY (transaction_id) NOT ENFORCED
)
PARTITION BY business_date
CLUSTER BY location_id
OPTIONS (
  description = "At-least-once loaded transactions; read via vw_fact_transactions.",
  require_partition_filter = FALSE
);
