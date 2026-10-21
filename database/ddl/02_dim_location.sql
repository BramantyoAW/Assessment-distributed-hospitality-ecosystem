-- Star schema: location dimension.
--
-- Grain: one row per physical area whose footfall is counted.
-- `timezone` exists for future multi-property use; this assessment runs one
-- venue, so every row carries Asia/Makassar and business_date derivation stays
-- simple.

CREATE TABLE IF NOT EXISTS finns_hospitality.dim_location (
  location_id STRING NOT NULL,
  name        STRING NOT NULL,
  area        STRING,          -- beachfront | pool | restaurant | lobby
  capacity    INT64,
  is_outdoor  BOOL   NOT NULL,
  timezone    STRING NOT NULL,
  opened_on   DATE,
  PRIMARY KEY (location_id) NOT ENFORCED
)
OPTIONS (
  description = "One row per countable area. Joined by both fact tables."
);
