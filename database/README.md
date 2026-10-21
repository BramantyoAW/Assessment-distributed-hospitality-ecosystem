# Warehouse: schema, seeds and queries

BigQuery dataset `finns_hospitality`, region `asia-southeast2` (Jakarta). Star
schema, two fact tables, two dimensions, one checkpoint table and two dedupe views.

## Tables

| Table | Grain | Key | Partition | Cluster |
| --- | --- | --- | --- | --- |
| `dim_date` | one business day | `date` | none | none |
| `dim_location` | one countable area | `location_id` | none | none |
| `fact_transactions` | one PMS transaction | `transaction_id` | `business_date` | `location_id` |
| `fact_camera_events` | one camera reading | `event_id` | `business_date` | `location_id` |
| `ingest_checkpoint` | one ingest run | none (append-only) | `DATE(written_at)` | none |

`PRIMARY KEY … NOT ENFORCED` is documentation, not a constraint: BigQuery accepts a
duplicate `transaction_id` without complaint. The load path is therefore
at-least-once, and correctness comes from the views below. Believing the primary key
deduplicates is the fastest way to double-count revenue.

## Views: the only read path

- `vw_fact_transactions` — one row per `transaction_id`, newest
  `source_modified_at` wins, `ingested_at` breaks ties. Source version first, because
  a correction loaded later must beat the stale row it replaces.
- `vw_fact_camera_events` — one row per `event_id`, newest `received_at` wins.
  Readings are immutable, so any copy is as good as another.

Every query in `queries/` reads a view. `gcp-middleware/tests/database.test.ts`
fails if a query touches a base fact table, and if the documented files drift from
the SQL the code actually runs.

## Applying it

```bash
bq --location=asia-southeast2 mk --dataset "$PROJECT:finns_hospitality"

for file in database/ddl/*.sql; do
  bq query --use_legacy_sql=false --project_id="$PROJECT" < "$file"
done

bq query --use_legacy_sql=false --project_id="$PROJECT" < database/seed/dim_location.sql
bq query --use_legacy_sql=false --project_id="$PROJECT" < database/seed/dim_date.sql
```

Order matters only for `05_views_dedupe.sql`, which needs both fact tables. The
alphabetical loop happens to satisfy that.

## Bronze BigQuery Sandbox constraints

The Sandbox has no DML. Every file here is `CREATE`/`CREATE OR REPLACE`, and every
write from the application is a load job with `WRITE_APPEND`. Consequences worth
knowing before editing anything:

- No `MERGE` upsert. Duplicates are expected and removed by the views.
- No streaming inserts (`insertAll`, Storage Write API).
- Seeds use `CREATE OR REPLACE … AS SELECT`, so a re-run replaces rows instead of
  appending a second copy.
- A load job is capped at 10 MB per request. The batcher caps at 500 rows per batch.

## Running a query by hand

```bash
bq query --use_legacy_sql=false --dataset_id=finns_hospitality \
  --parameter=location_id::loc-beach-club \
  --parameter=from_date:DATE:2026-05-01 \
  --parameter=to_date:DATE:2026-05-01 \
  --parameter=row_limit:INT64:100 \
  < database/queries/transactions.sql
```

(`--dataset_id` supplies the default dataset so the SQL stays dataset-agnostic.)

## The fixture that keeps the conversion query honest

Correct: aggregate each fact, then join. 3 transactions (100 + 200 + 300) and 2
readings (10 + 15) give conversion `0.12`, revenue `600.00`, visits `25`.

Wrong: join the facts first and aggregate. The same data gives `0.04`, `1200.00` and
`75`, because each transaction is multiplied by the number of camera readings. Every
number is wrong and none looks wrong. `gcp-middleware/tests/conversion.test.ts` pins
both the correct triple and the absence of the wrong one.

## Regenerating `queries/*.sql`

Those files are generated from `gcp-middleware/src/bigquery/queries.ts` so the
documented command and the running code cannot disagree. After editing the constants:

```bash
npm run build
node --input-type=module -e '
import { writeFileSync } from "node:fs";
const q = await import("./dist/gcp-middleware/src/bigquery/queries.js");
for (const [name, sql] of Object.entries({locations: q.LOCATIONS_SQL, transactions: q.TRANSACTIONS_SQL, visitor_counts: q.VISITOR_COUNTS_HOUR_SQL, conversion_metrics: q.CONVERSION_METRICS_SQL, ingest_checkpoint_latest: q.CHECKPOINT_LATEST_SQL})) {
  writeFileSync(`database/queries/${name}.sql`, "-- regenerate with the command in database/README.md\n\n" + sql.trimStart());
}
'
```

Then run the tests: `database.test.ts` compares both copies and fails on drift.

## Known gaps

- `dim_date.is_holiday` is `FALSE` everywhere. Indonesian holidays are set yearly by
  decree; hard-coding them would be a guess presented as data.
- `occurred_at_source` has an `imputed` value reserved in the DDL comment but unused.
  Nothing imputes a timestamp today, so nothing writes it.
- No data-retention or cost policy. Sandbox has no billing; a real project would need
  partition expiry.
