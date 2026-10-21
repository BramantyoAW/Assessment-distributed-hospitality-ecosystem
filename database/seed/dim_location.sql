-- Seed: the four countable areas of the property.
--
-- Idempotent: CREATE OR REPLACE TABLE, because BigQuery Sandbox forbids DML
-- (INSERT / MERGE) and DELETE-then-INSERT is not available either. The PK is
-- declared here for documentation even though a CTAS cannot carry it, and it is
-- NOT ENFORCED regardless.
--
-- Names are the ones used in the demo queries and the README curl examples, so a
-- reviewer can paste a query and get rows back.

CREATE OR REPLACE TABLE finns_hospitality.dim_location AS
SELECT * FROM UNNEST([
  STRUCT('loc-beach-club'  AS location_id, 'Beach Club'        AS name,
         'beachfront'      AS area,        400               AS capacity,
         TRUE              AS is_outdoor,  'Asia/Makassar'   AS timezone,
         DATE '2024-01-01' AS opened_on),
  STRUCT('loc-pool'        AS location_id, 'Main Pool'         AS name,
         'pool'            AS area,        120               AS capacity,
         TRUE              AS is_outdoor,  'Asia/Makassar'   AS timezone,
         DATE '2024-01-01' AS opened_on),
  STRUCT('loc-restaurant'  AS location_id, 'Sunset Restaurant' AS name,
         'restaurant'      AS area,        180               AS capacity,
         FALSE             AS is_outdoor,  'Asia/Makassar'   AS timezone,
         DATE '2024-01-01' AS opened_on),
  STRUCT('loc-lobby'       AS location_id, 'Lobby'             AS name,
         'lobby'           AS area,        80                AS capacity,
         FALSE             AS is_outdoor,  'Asia/Makassar'   AS timezone,
         DATE '2024-01-01' AS opened_on)
]);
