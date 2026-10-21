-- Star schema: date dimension.
--
-- Grain: one row per business day on the venue calendar (Asia/Makassar).
-- Not partitioned: ~3,700 rows for a decade, where partitions would add
-- overhead and no pruning benefit.
--
-- The natural key is the DATE itself. A surrogate date_key INT64 (YYYYMMDD)
-- would add a FORMAT_DATE/PARSE_DATE conversion to every query and every test,
-- which is exactly where timezone bugs hide.

CREATE TABLE IF NOT EXISTS finns_hospitality.dim_date (
  date         DATE   NOT NULL,
  year         INT64  NOT NULL,
  quarter      INT64  NOT NULL,
  month        INT64  NOT NULL,
  day_of_month INT64  NOT NULL,
  day_of_week  STRING NOT NULL,   -- MONDAY .. SUNDAY
  is_weekend   BOOL   NOT NULL,
  is_holiday   BOOL   NOT NULL,
  holiday_name STRING,
  PRIMARY KEY (date) NOT ENFORCED
)
OPTIONS (
  description = "One row per business day (Asia/Makassar). Natural key: date."
);
