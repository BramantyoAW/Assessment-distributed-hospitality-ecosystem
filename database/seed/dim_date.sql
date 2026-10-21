-- Seed: date dimension, 2026-01-01 .. 2027-12-31.
--
-- Generated, not pasted: 731 literal rows would be a maintenance liability and
-- an invitation to typos, and GENERATE_DATE_ARRAY is the platform feature that
-- already does this.
--
-- `is_holiday` is FALSE for every row. Indonesian holiday dates are set by
-- ministerial decree and change yearly, so hard-coding them here would be a
-- guess presented as data. A reviewer can join a holiday calendar later; the
-- column exists so that join has somewhere to land.
--
-- Extend the range by editing the two literals below and re-running this file.

CREATE OR REPLACE TABLE finns_hospitality.dim_date AS
SELECT
  day                                  AS date,
  EXTRACT(YEAR    FROM day)            AS year,
  EXTRACT(QUARTER FROM day)            AS quarter,
  EXTRACT(MONTH   FROM day)            AS month,
  EXTRACT(DAY     FROM day)            AS day_of_month,
  FORMAT_DATE('%A', day)               AS day_of_week,
  EXTRACT(DAYOFWEEK FROM day) IN (1, 7) AS is_weekend,
  FALSE                                AS is_holiday,
  CAST(NULL AS STRING)                 AS holiday_name
FROM UNNEST(GENERATE_DATE_ARRAY(DATE '2026-01-01', DATE '2027-12-31', INTERVAL 1 DAY)) AS day;
