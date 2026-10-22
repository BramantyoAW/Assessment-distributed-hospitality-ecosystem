# FINNS — Distributed Hospitality Ecosystem

Assessment implementation of the FINNS Software Engineer brief: Modules 1–4 plus the
warehouse in `database/`. Detail lives in `deploy/`, `database/` and `gcp-middleware/`.

```
Cameras  ─POST─> Module 2 (edge buffer) ─batch──┐
Opera    ─POST─> Module 1 (edge queue) ─HMAC─> NetSuite
NetSuite ─SuiteQL─> Cloud Run Job ─────────────┴─> BigQuery ─> GraphQL (Module 3)
```

## Quick start (no cloud, no credentials)

```bash
npm install              # needs Node 24 (node:sqlite, --env-file)
npm test                 # 180 tests, 0 failures
cp .env.example .env
npm run start:graphql    # :3003 GraphQL, in-memory gateway
npm run start:opera      # :3001 POST /webhook/opera
npm run start:iot        # :3002 POST /api/v1/iot/people-count
npm run mock:netsuite    # :4010 fake NetSuite, for a local end-to-end run
```

## Surfaces

| Module | Surface | Notes |
| --- | --- | --- |
| 1 — Opera webhook | `POST /webhook/opera` | Bearer token, durable SQLite queue, HMAC egress, `202` before any NetSuite call |
| 2 — IoT people count | `POST /api/v1/iot/people-count` | `X-API-Key`; `/ingest/people-count` alias; micro-batched |
| 3 — GraphQL API | `POST /graphql`, `GET /healthz` | Cloud Run IAM only; `/healthz` behind the same gate |
| 4 — Warehouse | `database/ddl`, `database/queries` | BigQuery; per-table IAM in `deploy/iam.yaml` |

## Idempotency (Module 1)

Three layers, because each covers a different failure: `UNIQUE(event_id)` rejects the
duplicate at ingress; the egress call carries an `Idempotency-Key`, so a retry is not a new
event; the warehouse keeps one row per key. A duplicate is still `202`, with body
`{"status":"duplicate"}` — same status, different body. Raw bytes are stored as a `BLOB`
because the HMAC covers the bytes that arrived; re-serialising via `JSON.stringify` can
reorder keys, and the signature stops matching.

## BigQuery authentication, edge IoT (Module 2)

The edge host is not a Google machine, so it cannot assume an attached service account. In
production it reads a token from the **metadata server** (`src/bigquery/token.ts`), which
needs a service account attached to the GCE instance — no key file, nothing to leak. Where
no attachment exists (laptop, property VM) the default adapter is `BQ_ADAPTER=jsonl`: local
NDJSON, no credential at all. The third case, a non-Google host, is Workload Identity
Federation — documented in `deploy/wif.md`, explicitly **not implemented**; the
`TokenProvider` interface exists so it can be added without touching the batcher. IAM limits
edge writes to one table, `fact_camera_events`.

## GCP OIDC and Secret Manager (Module 3)

- **Callers:** Google OIDC through Cloud Run IAM, invoker-only. No API key inside the
  service, and `/healthz` sits behind the same gate. No per-query authorisation — a stated
  limitation, not an oversight.
- **Service and Job:** ADC from their attached service accounts; no JSON key is created,
  mounted or baked into an image.
- **NetSuite key:** Secret Manager, injected as an environment variable at deploy time —
  never in the image, never in git. Each token request signs a PS256 assertion carrying
  `kid` and `scope=rest_webservices`; omitting either yields an unhelpful `invalid_client`.

## N+1 mitigation (Module 3)

A per-request DataLoader batches calls within one tick: 4 locations → 1 query, 50
transactions plus their locations → 1 query, instead of 4 and 51. Loaders are rebuilt per
request, so one caller's rows never reach another's. Tests assert the **call count**, not
the values — a cache also returns correct values and would hide the N+1. Depth is capped at
6 (fragments resolved); `limit` is clamped to 500, not rejected.

## Dedupe and aggregation (Module 4)

Every write is a load job with `WRITE_APPEND` — the Sandbox forbids `MERGE` and streaming
inserts — so replays append duplicates on purpose. `PRIMARY KEY … NOT ENFORCED` enforces
nothing; the real guarantee is the view. `vw_fact_transactions` orders by
`source_modified_at` first and `ingested_at` second, so a corrected amount beats the stale
row it replaces.

Facts are aggregated **separately, then joined**: joining first multiplies each transaction
by the number of readings, so 3 transactions (100/200/300) over 2 readings (10/15) reports
conversion `0.04` instead of `0.12`, revenue `1200` instead of `600` — every number wrong,
none looking wrong. `business_date` comes from `Asia/Makassar`, so 00:30 WITA is not filed
a day early.

## Verification: what was actually run

`npm run build` and `npm test` (180 tests, 0 failures); Module 1 and 2 HTTP surfaces,
batching, retry, dead-letter and shutdown flush; GraphQL end to end on the in-memory
gateway; the PS256 assertion against a local key pair; the BigQuery load-job request shape
against an injected `fetch`.

**Also executed on a Multipass VM** (Ubuntu 26.04, aarch64, systemd 259, Node 24.22.0): both
units as real services, `active (running)`, automatic start after `reboot` with queue and
buffer intact, `SIGKILL` recovered by `Restart=always` (`NRestarts` 0→1) without losing an
event, and the shutdown flush delivering 3 buffered rows on `SIGTERM`. See `deploy/README.md`.

**Not executed, and not claimed:** any real BigQuery query or load, any real NetSuite call,
Cloud Run deploy, IAM bindings, Secret Manager, and Workload Identity Federation — there is
no `gcloud`, project or ADC here. Commands are in `deploy/`, labelled with their status,
including the BigQuery `--dry_run` that must be re-run once a project exists.

## Operating the edge services

Task 1.3 asks for one command that searches a 50 GB log page by page without loading it into
RAM; `less` streams, so memory stays flat regardless of file size:

```bash
grep -a --line-buffered 'TIMEOUT' /var/log/edge-webhook/edge-webhook.log | less
sudo journalctl -u edge-webhook.service --since "24 hours ago" --no-pager | grep -iE 'timeout|timed out'
```

The path is a file, not a directory: `StandardOutput=append:` writes the application's JSON
there, while systemd keeps lifecycle records in the journal — so grep the file for timeouts,
the journal for restarts. Details: `deploy/README.md` §5 and §9.

## Documentation

VM install and journal search: `deploy/README.md`. Unverified list: `deploy/cloudrun.md`.
Auth planes: `deploy/wif.md`. Schema: `database/README.md`. GraphQL: `gcp-middleware/README.md`.
