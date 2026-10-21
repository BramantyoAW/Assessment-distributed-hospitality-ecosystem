# Deploying the cloud tier (Cloud Run Service + Job)

Two deployables from one repository, because they are one codebase and two
lifetimes: the GraphQL API answers requests, the ingest job runs for a few seconds
and exits.

| What | Cloud Run type | Entry point | Scaling |
| --- | --- | --- | --- |
| GraphQL API | Service | `npm start` → `dist/gcp-middleware/src/main.js` | `min-instances=0`, `max-instances=4` |
| NetSuite ingest | Job | `npm run job:ingest` | none, one task per execution |

`min-instances=0` is a real trade-off, not an oversight: the first request after
idle pays a cold start of roughly 1–3 seconds (Node boot plus ADC token fetch).
Keeping one warm instance would remove that and cost money around the clock. For an
internal analytics API the cold start is the better deal, and it is documented so
nobody spends an afternoon debugging the first slow query of the morning.

Every command below is **NOT EXECUTED** on the development machine: there is no
`gcloud`, no project and no credentials here. They are the commands to run, in
order, on a machine that has them.

## 0. Prerequisites

```bash
PROJECT=your-project-id
REGION=asia-southeast2           # Jakarta; matches BQ_LOCATION
DATASET=finns_hospitality
gcloud config set project "$PROJECT"
gcloud services enable run.googleapis.com bigquery.googleapis.com \
  cloudscheduler.googleapis.com secretmanager.googleapis.com
```

BigQuery **Sandbox** is enough: no billing account, but also no DML, no `MERGE` and
no streaming inserts. That is why every write in this repository is a load job.

## 1. Create the dataset and the tables

```bash
bq --location=asia-southeast2 mk --dataset "$PROJECT:$DATASET"

for file in database/ddl/*.sql; do
  bq query --use_legacy_sql=false --project_id="$PROJECT" < "$file"
done

bq query --use_legacy_sql=false --project_id="$PROJECT" < database/seed/dim_location.sql
bq query --use_legacy_sql=false --project_id="$PROJECT" < database/seed/dim_date.sql
```

Order matters only for the views (`05_*`): they reference the tables created by
`03_*` and `04_*`. The `for` loop is alphabetical, which happens to be correct.

## 2. Verify the SQL without spending a byte

A dry run validates syntax, column names and permissions, and costs nothing.

```bash
bq query --use_legacy_sql=false --dry_run --project_id="$PROJECT" \
  --dataset_id="$DATASET" < database/queries/conversion_metrics.sql
```

Do this before deploying the service: a typo in a column name surfaces here, not as
a 500 from the first user query. **Status: NOT EXECUTED** — no project available.

## 3. Deploy the GraphQL service

```bash
gcloud run deploy finns-graphql \
  --source . \
  --region "$REGION" \
  --no-allow-unauthenticated \
  --min-instances 0 \
  --max-instances 4 \
  --service-account "gcp-graphql@$PROJECT.iam.gserviceaccount.com" \
  --set-env-vars "NODE_ENV=production,BQ_GATEWAY=bigquery,BQ_PROJECT=$PROJECT,BQ_DATASET=$DATASET,BQ_LOCATION=$REGION"
```

`NODE_ENV=production` is what arms the `K_SERVICE` guard: the service refuses to
start outside Cloud Run in production, because Cloud Run IAM is its only
authentication layer and that gate does not exist anywhere else.

`--source .` uses buildpacks, so Docker is not required. The build runs
`npm run gcp-build` (which is `npm run build`) and Cloud Run then runs `npm start`.

There is no unauthenticated route. `/healthz` is behind the invoker gate as well, so
a plain `curl` gets 403. Probe it with a token:

```bash
TOKEN="$(gcloud auth print-identity-token)"
URL="$(gcloud run services describe finns-graphql --region "$REGION" --format='value(status.url)')"

curl -sS -H "Authorization: Bearer $TOKEN" "$URL/healthz"
curl -sS -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"query":"{ locations { id name } }"}' "$URL/graphql"
```

## 4. Deploy the ingest job

```bash
gcloud secrets create finns-netsuite-private-key --data-file=./netsuite-key.pem

gcloud run jobs deploy finns-ingest \
  --source . \
  --region "$REGION" \
  --command node \
  --args dist/gcp-middleware/src/jobs/transactions.js \
  --service-account "gcp-ingest@$PROJECT.iam.gserviceaccount.com" \
  --set-secrets "NETSUITE_PRIVATE_KEY=finns-netsuite-private-key:latest" \
  --set-env-vars "NODE_ENV=production,BQ_GATEWAY=bigquery,BQ_PROJECT=$PROJECT,BQ_DATASET=$DATASET,BQ_LOCATION=$REGION,NETSUITE_ACCOUNT_ID=1234567,NETSUITE_CLIENT_ID=...,NETSUITE_CERTIFICATE_ID=...,NETSUITE_BOOTSTRAP_SINCE=2026-01-01T00:00:00Z,NETSUITE_LOCATION_MAP={\"2\":\"loc-pool\"}"
```

Then run it once and read the log:

```bash
gcloud run jobs execute finns-ingest --region "$REGION" --wait
gcloud run jobs executions list --job finns-ingest --region "$REGION" --limit 1
```

A non-zero exit means the run could not complete (no token, no BigQuery, unreadable
checkpoint). Rows rejected by the mapper do **not** fail the run: they are counted in
`ingest_summary` and stored in `ingest_checkpoint.rows_rejected`, because failing the
job on one bad source row would stop the cursor forever.

Schedule it every 10 minutes:

```bash
gcloud scheduler jobs create http finns-ingest-every-10m \
  --location "$REGION" \
  --schedule "*/10 * * * *" \
  --uri "https://$REGION-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/$PROJECT/jobs/finns-ingest:run" \
  --http-method POST \
  --oauth-service-account-email "gcp-ingest@$PROJECT.iam.gserviceaccount.com"
```

## 5. What is verified, and what is not

Verified on the development machine (executed, output observed):

- `npm run build`, `npm test` — 164 tests, 0 failures.
- Every SQL statement is exercised by tests through an in-memory gateway with the
  same semantics as the views, including the aggregate-before-join fixture.
- The BigQuery load-job request shape (multipart, `WRITE_APPEND`, explicit schema,
  eight columns) is asserted against an injected `fetch`.

Not verified, and labelled as such everywhere it appears:

- Anything that needs a real project: DDL execution, dry run, IAM bindings,
  Secret Manager, Cloud Run deploy, Scheduler, WIF.
- A live NetSuite sandbox call: the PS256 assertion is verified locally against a
  locally generated key pair, but no real account has ever accepted it.
- The buildpacks build (`gcloud run deploy --source .`).

Remaining known gap: BigQuery Sandbox caps a load job at 10 MB per request. The
batcher caps a batch at 500 rows, so this is far from the limit, but a future
`BATCH_MAX_SIZE` above a few thousand would hit it and must switch to multiple jobs.
