# Cloud tier: GraphQL API (Module 3) + NetSuite ingest

Two entry points, one configuration loader each, one warehouse boundary shared by
both.

| Entry point | Command | Runs as | HTTP |
| --- | --- | --- | --- |
| GraphQL service | `npm start` | Cloud Run Service | `POST /graphql`, `GET /healthz` |
| Transaction ingest | `npm run job:ingest` | Cloud Run Job | none |

## Local run

```bash
npm run start:graphql    # in-memory gateway, seeded with the four locations
curl -sS -H 'content-type: application/json' \
  -d '{"query":"{ locations { id name conversionRate(date: \"2026-05-01\") { conversionRate totalVisits } } }"}' \
  http://127.0.0.1:3003/graphql
```

`BQ_GATEWAY=memory` (the default) stores rows in process and applies the same
dedupe and aggregate-before-join rules as BigQuery. It is how every test runs, and
it is why the conversion fixture can be asserted without a project.

## Query shape

```graphql
{
  location(id: "loc-beach-club") {
    name
    conversionRate(date: "2026-05-01") {
      totalTransactions
      totalRevenue
      totalVisits
      cameraSeconds
      conversionRate
    }
    visitorCounts(from: "2026-05-01", to: "2026-05-01", bucket: HOUR) {
      bucketStart
      visits
    }
  }
  transactions(locationId: "loc-beach-club", from: "2026-05-01", to: "2026-05-01", limit: 50) {
    id
    amount
    guests
    occurredAtSource
  }
}
```

Contract decisions a client should not have to guess:

- `amount` and `totalRevenue` are `String`. A `Float` would undo the `NUMERIC`
  column the value came from.
- `guests` is nullable: `null` means the source did not say, and that is not `0`.
- `conversionRate` is nullable: `null` means "no camera data, not measurable", `0`
  means "measured, nobody converted". Rendering both as 0% is how a location with a
  dead camera looks healthy.
- `occurredAt` is nullable alongside `occurredAtSource`. A date-only `trandate` has
  no time, so the field says `UNAVAILABLE` instead of inventing midnight.
- `limit` is clamped to 500, never rejected: a client asking for 10,000 rows gets 500
  working rows, not an error it cannot learn from.
- A query deeper than 6 levels is refused before execution, fragments included. Each
  level of `location { conversionRate { location { … } } }` is another warehouse call,
  and DataLoader removes N+1 within a level, not the cycle.

## Why DataLoader

`{ locations { conversionRate(date: …) } }` is 4 metric lookups done naively, and 50
transactions with `location { name }` is 51. Two loaders collapse each of those into
one batched call per request: 4 locations → 1 query, 50 transactions → 1 query.
`tests/graphql.test.ts` asserts the call *counts*; a cache would also return correct
values, and caching was never the problem.

Loaders are constructed per request. A shared cache would serve one caller's rows to
another and would never see an update.

## Layout

```
src/
  main.ts                 Cloud Run Service entry (GraphQL)
  server.ts               POST /graphql, GET /healthz, no ingest route
  config.ts               loadServiceConfig / loadJobConfig (K_SERVICE guard for the service only)
  jobs/transactions.ts    Cloud Run Job entry
  ingest/
    config.ts             NetSuite + paging settings
    transactions.job.ts   keyset pull, mapping, checkpoint
    dedupe.ts             newest-wins, shared by the memory gateway
  netsuite/
    auth.ts               PS256 client assertion + token cache
    client.ts             SuiteQL keyset page fetch
    mapping.ts            row -> fact, with counted rejections
  bigquery/
    gateway.ts            the boundary (read + write + checkpoint)
    queries.ts            the SQL, mirrored in database/queries/*.sql
    bigquery.gateway.ts   real implementation, load jobs only
    memory.gateway.ts     in-memory implementation used by tests
    factory.ts            config -> gateway
  schema/                 typeDefs, resolvers, depth guard
  dataloader/loaders.ts   batched location + conversion loaders
```

## Ingest: checkpoint, not `MAX()`

Each run reads the newest cursor from `ingest_checkpoint` (append-only, written by a
load job — the Sandbox forbids `UPDATE`), subtracts `NETSUITE_LOOKBACK_MINUTES`, and
pages forward with a `(lastmodifieddate, id)` keyset.

- `MAX(source_modified_at)` would skip a late correction whose modification date is
  older than the newest one already loaded, and says nothing about what was actually
  read when a run dies mid-page.
- `OFFSET` paging makes a backfill quadratic and can skip or repeat rows when records
  are created during the scan.
- The overlap re-reads a window and relies on the dedupe view, so it costs nothing
  but correctness gained.
- The cursor comes from the last **raw** row, so a page of rejected rows still
  advances it. Otherwise one bad row would stall ingest forever.
- Rejected rows are counted in `ingest_summary` and in `ingest_checkpoint.rows_rejected`
  and do **not** fail the job.

## Environment

Service: `NODE_ENV`, `PORT` (Cloud Run), `K_SERVICE` (Cloud Run), `BQ_GATEWAY`,
`BQ_PROJECT`, `BQ_DATASET`, `BQ_LOCATION`, `BUSINESS_TIMEZONE`, `QUERY_TIMEOUT_MS`,
`MAX_QUERY_ROWS`.

Job: the same BigQuery settings plus `NETSUITE_ACCOUNT_ID`, `NETSUITE_CLIENT_ID`,
`NETSUITE_CERTIFICATE_ID`, `NETSUITE_PRIVATE_KEY` (PEM), `NETSUITE_BASE_URL`,
`NETSUITE_SCOPE`, `NETSUITE_BOOTSTRAP_SINCE`, `NETSUITE_LOOKBACK_MINUTES`,
`NETSUITE_LOCATION_MAP`, `INGEST_PAGE_SIZE`, `INGEST_MAX_PAGES`.

`NETSUITE_BOOTSTRAP_SINCE` is required, not defaulted: how much history to backfill is
an operational decision, not a hidden constant.

## Verification status

Executed here: `npm run build`, `npm test` (164 tests), the GraphQL HTTP surface, the
PS256 assertion against a locally generated key pair, and the load-job request shape
against an injected `fetch`.

Not executed: any real BigQuery query or load, any real NetSuite call, Cloud Run,
IAM, WIF, Secret Manager. See `deploy/cloudrun.md` for the commands and
`deploy/wif.md` for the three auth planes.
