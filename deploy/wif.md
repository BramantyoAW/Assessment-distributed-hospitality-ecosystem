# Three authentication planes (and why there are three)

Every hop in this system authenticates differently because each hop trusts a
different thing. Collapsing them into one mechanism is how "we use OAuth" ends up
meaning three different things in one diagram.

| Plane | Who talks | Mechanism | Credential storage |
| --- | --- | --- | --- |
| A | Ingest job → NetSuite | OAuth 2.0 client credentials + PS256 client assertion | Secret Manager, injected as env |
| B | Service/Job → BigQuery | Google ADC from the attached service account | none (metadata server) |
| C | On-prem edge host → GCP | Workload Identity Federation: OIDC JWT → STS → impersonation | no long-lived key |
| D | Caller → GraphQL service | Cloud Run IAM ID token | caller's Google identity |

## A. NetSuite: PS256, not RS256

NetSuite's certificate-based machine-to-machine flow requires an RSASSA-PSS
assertion (`alg: PS256`, salt length 32) whose header carries `kid`, the id of the
certificate uploaded to NetSuite. Two mistakes are common and both produce the same
unhelpful `invalid_client`:

- signing with `RS256` — the algorithm NetSuite refuses for this flow;
- omitting `scope=rest_webservices` from the assertion, which yields a token with no
  REST scope and a 403 on the first call.

Implemented in `gcp-middleware/src/netsuite/auth.ts`, verified locally with a
generated key pair (`netsuite.test.ts`), never against a live account.

## B. BigQuery: attached service account, no key file

Cloud Run attaches `gcp-graphql@` / `gcp-ingest@`; `@google-cloud/bigquery` picks the
token up through ADC. No JSON key is created, mounted or baked into an image.

The Module 2 edge adapter does the same thing through the metadata server
(`edge-middleware/module-2-iot/src/bigquery/token.ts`), which is why it works on a GCE
instance with an attached service account and does not work on a laptop.

## C. On-prem edge → GCP (Workload Identity Federation)

The property host is not a Google machine, so it cannot have an attached service
account. WIF trades the long-lived key for a short-lived one:

```bash
PROJECT=your-project-id

gcloud iam workload-identity-pools create finns-edge \
  --location=global --project="$PROJECT"

gcloud iam workload-identity-pools providers create-oidc finns-edge-oidc \
  --location=global \
  --workload-identity-pool=finns-edge \
  --issuer-uri="https://auth.example.com/realms/finns" \
  --allowed-audiences="finns-edge" \
  --attribute-mapping="google.subject=assertion.sub,attribute.host=assertion.host" \
  --project="$PROJECT"

gcloud iam service-accounts add-iam-policy-binding \
  "edge-webhook@$PROJECT.iam.gserviceaccount.com" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT/locations/global/workloadIdentityPools/finns-edge/attribute.host/edge-01"
```

The exchange itself (OIDC JWT → STS token → service-account access token) is **not
implemented in this repository**. It needs a real identity provider, a real pool and
a real host, none of which exist here; writing the code and labelling it "works"
would be the exact claim the assessment forbids. The two supported deployments
today are:

1. the edge host runs on GCE with an attached service account (metadata token, used
   by `token.ts`), or
2. `BQ_ADAPTER=jsonl`, which writes local NDJSON and needs no GCP credential at all —
   the default, and what every test exercises.

Anything else must supply its own `TokenProvider`; the interface exists precisely so
that WIF can be dropped in without touching the batcher, the adapter or the schema.

## D. Callers: Cloud Run IAM only

The service has no API key, no bearer-token check and no in-process auth. It relies
entirely on Cloud Run's invoker gate (`--no-allow-unauthenticated`), which means:

- every route is protected, including `/healthz`;
- authorization granularity is "can invoke the service" — there is no per-query or
  per-location authorisation. For a single-property internal API that is an accepted
  limitation, and it is the reason the service refuses to start outside Cloud Run
  when `NODE_ENV=production`: without the gate there is no authentication at all.

## Why not one plane for everything

Because they answer different questions. Plane A proves "this job may read this
NetSuite account". Plane B proves "this process runs as this service account inside
this project" — a secret would weaken it. Plane C proves "this request came from
that host", without a key to steal. Plane D proves "this human may call this API".
One mechanism that satisfied all four would be the weakest of the four.
