import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { loadJobConfig, loadServiceConfig } from '../src/config.js';

const CLOUD_RUN_SERVICE_ENV = { K_SERVICE: 'gcp-middleware' } as const;

test('service config defaults are usable for local development', () => {
  const config = loadServiceConfig({});

  assert.equal(config.kind, 'service');
  assert.equal(config.port, 3003);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.nodeEnv, 'development');
  assert.equal(config.businessTimezone, 'Asia/Makassar');
  assert.equal(config.bigquery.gateway, 'memory');
  assert.equal(config.bigquery.dataset, 'finns_hospitality');
  assert.equal(config.bigquery.location, 'asia-southeast2');
  assert.equal(config.maxQueryRows, 500);
  assert.equal(config.runsOnCloudRun, false);
});

test('service reads PORT because Cloud Run injects 8080', () => {
  const config = loadServiceConfig({ PORT: '8080', ...CLOUD_RUN_SERVICE_ENV });

  assert.equal(config.port, 8080);
  assert.equal(config.runsOnCloudRun, true);
});

test('service refuses NODE_ENV=production without K_SERVICE', () => {
  assert.throws(
    () => loadServiceConfig({ NODE_ENV: 'production' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /K_SERVICE/);
      assert.match(error.message, /Cloud Run IAM/);
      return true;
    },
  );
});

test('service starts in production when Cloud Run injected K_SERVICE', () => {
  const config = loadServiceConfig({ NODE_ENV: 'production', ...CLOUD_RUN_SERVICE_ENV });

  assert.equal(config.nodeEnv, 'production');
  assert.equal(config.runsOnCloudRun, true);
});

test('the JOB must not depend on K_SERVICE: production job config loads without it', () => {
  // Gate 1: the job is triggered through the Cloud Run Admin API and never
  // receives K_SERVICE, so requiring it would make every execution fail.
  const config = loadJobConfig({ NODE_ENV: 'production', BQ_GATEWAY: 'bigquery', BQ_PROJECT: 'p' });

  assert.equal(config.kind, 'job');
  assert.equal(config.nodeEnv, 'production');
  assert.equal(config.bigquery.gateway, 'bigquery');
});

test('job config exposes no port, because the job opens no HTTP listener', () => {
  const config = loadJobConfig({ PORT: '8080' });

  assert.equal('port' in config, false);
});

test('bigquery gateway without BQ_PROJECT is refused at boot', () => {
  assert.throws(
    () => loadServiceConfig({ BQ_GATEWAY: 'bigquery' }),
    /BQ_PROJECT is required when BQ_GATEWAY=bigquery/,
  );
  assert.throws(
    () => loadJobConfig({ NODE_ENV: 'production', BQ_GATEWAY: 'bigquery' }),
    /BQ_PROJECT is required when BQ_GATEWAY=bigquery/,
  );
});

test('an out-of-range PORT is rejected instead of silently defaulted', () => {
  assert.throws(() => loadServiceConfig({ PORT: '0' }), /PORT must be an integer in \[1, 65535\]/);
  assert.throws(() => loadServiceConfig({ PORT: 'abc' }), /PORT must be an integer/);
});

test('an unknown timezone is rejected rather than producing wrong business dates', () => {
  assert.throws(
    () => loadServiceConfig({ BUSINESS_TIMEZONE: 'Asia/Makasar' }), // typo, one "s"
    /BUSINESS_TIMEZONE must be a valid IANA zone/,
  );
});

test('an unknown gateway name is rejected rather than defaulting to memory', () => {
  assert.throws(() => loadJobConfig({ BQ_GATEWAY: 'bq' }), /BQ_GATEWAY must be "memory" or "bigquery"/);
});

test('MAX_QUERY_ROWS cannot exceed the GraphQL page cap of 500', () => {
  assert.throws(() => loadJobConfig({ MAX_QUERY_ROWS: '501' }), /MAX_QUERY_ROWS must be an integer in \[1, 500\]/);
});
