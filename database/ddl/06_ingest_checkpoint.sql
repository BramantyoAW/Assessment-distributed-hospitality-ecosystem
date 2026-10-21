-- Ingest checkpoint: how far the NetSuite pull has read.
--
-- Append-only, written by a load job like any other fact data. The Sandbox
-- forbids DML, so "UPDATE the checkpoint row" is not available; instead each run
-- appends one row and readers take the newest per stream. That also keeps an
-- audit trail of how the cursor moved, which an in-place update would destroy.
--
-- Why a checkpoint and not `MAX(source_modified_at)` over the fact table:
-- a 30-day window of `MAX()` is wrong in both directions. It silently skips
-- records whose modification time is older than the window (a late correction),
-- and it has no notion of "I already read up to here" when the source clock
-- moves backwards. A stored cursor with a measured overlap bucket is a
-- statement about what was read, not an inference from what was written.
--
-- `stream` is a STRING (currently always "transactions") so a second feed does
-- not need a new table.

CREATE TABLE IF NOT EXISTS finns_hospitality.ingest_checkpoint (
  stream             STRING    NOT NULL,   -- transactions
  cursor_modified_at TIMESTAMP NOT NULL,   -- last raw source_modified_at read
  cursor_id          STRING    NOT NULL,   -- last raw transaction_id, for keyset ties
  overlap_minutes    INT64     NOT NULL,   -- re-read window before the cursor
  run_started_at     TIMESTAMP NOT NULL,
  pages              INT64     NOT NULL,
  rows_loaded        INT64     NOT NULL,
  rows_rejected      INT64     NOT NULL,
  written_at         TIMESTAMP NOT NULL
)
PARTITION BY DATE(written_at)
OPTIONS (
  description = "Append-only ingest cursors. Newest written_at per stream wins."
);
