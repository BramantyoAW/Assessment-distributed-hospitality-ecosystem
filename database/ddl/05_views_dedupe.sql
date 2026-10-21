-- Dedupe views. Every analytical query reads these, never the base tables.
--
-- Rationale: the load path is at-least-once (a retried batch, or a replay after
-- a network timeout, appends rows that already exist). BigQuery cannot reject
-- those: PRIMARY KEY ... NOT ENFORCED is documentation, not a constraint. So the
-- de-duplication must happen where it can be tested, and every consumer must be
-- forced through it. A view is the only place that is true for all consumers.
--
-- These are plain views, not materialized ones: a materialized view over
-- ROW_NUMBER() cannot be maintained incrementally, and the Sandbox forbids the
-- scheduled query that would otherwise refresh it.

-- Ordering is source_modified_at first, ingested_at second.
--
-- A transaction can be corrected in the PMS. `ingested_at DESC` alone would let
-- whichever copy was loaded last win, even when it is the older version of the
-- record, so a corrected 100.00 could be overwritten by the stale 999.00 it was
-- meant to replace. `source_modified_at` is the source's own notion of "newer";
-- `ingested_at` only breaks ties between two loads of the same version.
CREATE OR REPLACE VIEW finns_hospitality.vw_fact_transactions AS
SELECT * EXCEPT (dedupe_rank)
FROM (
  SELECT
    *,
    ROW_NUMBER() OVER (
      PARTITION BY transaction_id
      ORDER BY source_modified_at DESC, ingested_at DESC
    ) AS dedupe_rank
  FROM finns_hospitality.fact_transactions
)
WHERE dedupe_rank = 1;

-- Camera events are immutable: the camera sends a reading once and never
-- revises it. So a replay produces rows identical except for `received_at`, and
-- the newest received copy is as good as the oldest.
CREATE OR REPLACE VIEW finns_hospitality.vw_fact_camera_events AS
SELECT * EXCEPT (dedupe_rank)
FROM (
  SELECT
    *,
    ROW_NUMBER() OVER (
      PARTITION BY event_id
      ORDER BY received_at DESC
    ) AS dedupe_rank
  FROM finns_hospitality.fact_camera_events
)
WHERE dedupe_rank = 1;
