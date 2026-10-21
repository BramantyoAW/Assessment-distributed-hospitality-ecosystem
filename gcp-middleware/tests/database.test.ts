import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  CHECKPOINT_LATEST_SQL,
  CONVERSION_METRICS_SQL,
  LOCATIONS_SQL,
  TRANSACTIONS_SQL,
  VISITOR_COUNTS_HOUR_SQL,
} from '../src/bigquery/queries.js';

const DATABASE = join(process.cwd(), 'database');

function readSql(relativePath: string): string {
  return readFileSync(join(DATABASE, relativePath), 'utf8');
}

function normalise(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const DDL_FILES = [
  'ddl/01_dim_date.sql',
  'ddl/02_dim_location.sql',
  'ddl/03_fact_transactions.sql',
  'ddl/04_fact_camera_events.sql',
  'ddl/05_views_dedupe.sql',
  'ddl/06_ingest_checkpoint.sql',
];

test('all six DDL files exist and are not empty', () => {
  for (const file of DDL_FILES) {
    const sql = readSql(file);
    assert.ok(sql.length > 100, `${file} looks empty`);
  }

  assert.deepEqual(readdirSync(join(DATABASE, 'ddl')).sort(), DDL_FILES.map((f) => f.replace('ddl/', '')));
});

test('both fact tables are partitioned by business_date and clustered by location', () => {
  for (const file of ['ddl/03_fact_transactions.sql', 'ddl/04_fact_camera_events.sql']) {
    const sql = readSql(file);
    assert.match(sql, /PARTITION BY business_date/, `${file} must partition by the business date`);
    assert.match(sql, /CLUSTER BY location_id/, `${file} must cluster by location: every query filters on it`);
    assert.match(sql, /PRIMARY KEY \(\w+\) NOT ENFORCED/);
  }
});

test('money is NUMERIC and the event time is nullable with a stated provenance', () => {
  const sql = readSql('ddl/03_fact_transactions.sql');

  assert.match(sql, /amount\s+NUMERIC\s+NOT NULL/);
  assert.doesNotMatch(sql, /amount\s+FLOAT64/);
  assert.match(sql, /occurred_at\s+TIMESTAMP,/, 'occurred_at must be nullable');
  assert.match(sql, /occurred_at_source\s+STRING\s+NOT NULL/);
  assert.match(sql, /guests\s+INT64,/, 'guests must be nullable');
});

test('camera events carry interval_seconds as a required column', () => {
  const sql = readSql('ddl/04_fact_camera_events.sql');

  assert.match(sql, /interval_seconds\s+INT64\s+NOT NULL/);
  assert.match(sql, /business_date\s+DATE\s+NOT NULL/);

  const columns = [...sql.matchAll(/^\s{2}(\w+)\s+(?:STRING|INT64|TIMESTAMP|DATE)/gm)].map(
    (match) => match[1],
  );
  assert.deepEqual(columns, [
    'event_id',
    'location_id',
    'business_date',
    'camera_id',
    'observed_at',
    'received_at',
    'people_count',
    'interval_seconds',
  ]);
});

test('the dedupe views order transactions by source version, then ingest time', () => {
  const sql = readSql('ddl/05_views_dedupe.sql');

  assert.match(sql, /vw_fact_transactions/);
  assert.match(sql, /PARTITION BY transaction_id/);
  // A corrected row must beat the stale one: the source's own version first,
  // ingest time only as a tie-break.
  assert.match(sql, /ORDER BY source_modified_at DESC, ingested_at DESC/);
  assert.match(sql, /PARTITION BY event_id/);
  assert.match(sql, /ORDER BY received_at DESC/);
  assert.match(sql, /WHERE dedupe_rank = 1/);
});

test('no SQL file performs DML: the target environment forbids it', () => {
  for (const file of [...DDL_FILES, 'seed/dim_location.sql', 'seed/dim_date.sql']) {
    const sql = readSql(file).replace(/--.*$/gm, '');
    assert.doesNotMatch(sql, /\bMERGE\b/i, `${file} uses MERGE`);
    assert.doesNotMatch(sql, /^\s*INSERT\b/im, `${file} uses INSERT`);
    assert.doesNotMatch(sql, /^\s*UPDATE\b/im, `${file} uses UPDATE`);
    assert.doesNotMatch(sql, /^\s*DELETE\b/im, `${file} uses DELETE`);
  }
});

test('the seeds define the four locations and a generated date range', () => {
  const locations = readSql('seed/dim_location.sql');
  for (const id of ['loc-beach-club', 'loc-pool', 'loc-restaurant', 'loc-lobby']) {
    assert.ok(locations.includes(id), `seed must include ${id}`);
  }

  const dates = readSql('seed/dim_date.sql');
  assert.match(dates, /GENERATE_DATE_ARRAY/);
  assert.match(dates, /2026-01-01/);
});

test('documented query files and the code constants are the same SQL', () => {
  const pairs: [string, string][] = [
    ['queries/locations.sql', LOCATIONS_SQL],
    ['queries/transactions.sql', TRANSACTIONS_SQL],
    ['queries/visitor_counts.sql', VISITOR_COUNTS_HOUR_SQL],
    ['queries/conversion_metrics.sql', CONVERSION_METRICS_SQL],
    ['queries/ingest_checkpoint_latest.sql', CHECKPOINT_LATEST_SQL],
  ];

  for (const [file, constant] of pairs) {
    assert.equal(
      normalise(readSql(file)),
      normalise(constant),
      `${file} has drifted from the SQL the code actually runs`,
    );
  }
});

test('every analytical query reads a dedupe view, never a base fact table', () => {
  for (const file of readdirSync(join(DATABASE, 'queries'))) {
    const sql = readSql(join('queries', file)).replace(/--.*$/gm, '');
    assert.doesNotMatch(sql, /FROM\s+fact_/i, `${file} reads a base fact table`);
    assert.match(sql, /vw_fact_|dim_location|ingest_checkpoint/, `${file} reads nothing recognisable`);
  }
});

test('the conversion query aggregates each fact before joining', () => {
  const sql = normalise(CONVERSION_METRICS_SQL);

  // Both aggregates are computed in their own CTE over a single fact table.
  assert.match(sql, /txn AS \(/);
  assert.match(sql, /visits AS \(/);
  assert.match(sql, /LEFT JOIN txn/);
  assert.match(sql, /LEFT JOIN visits/);
  assert.match(sql, /SAFE_DIVIDE/);
  assert.doesNotMatch(sql, /JOIN vw_fact_camera_events[\s\S]*JOIN vw_fact_transactions[\s\S]*GROUP BY/);
});

test('the checkpoint table is append-only with a per-stream cursor', () => {
  const sql = readSql('ddl/06_ingest_checkpoint.sql');

  assert.match(sql, /cursor_modified_at\s+TIMESTAMP\s+NOT NULL/);
  assert.match(sql, /cursor_id\s+STRING\s+NOT NULL/);
  assert.match(sql, /overlap_minutes\s+INT64\s+NOT NULL/);
  assert.doesNotMatch(sql, /PRIMARY KEY/);
});
