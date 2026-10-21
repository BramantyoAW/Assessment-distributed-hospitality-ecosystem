import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import type { IotRow } from '../src/bigquery/adapter.js';
import {
  FACT_CAMERA_EVENT_COLUMNS,
  createBigQueryAdapter,
  serializeNdjson,
} from '../src/bigquery/bigquery.adapter.js';
import type { ColumnSchema, LoadJobClient } from '../src/bigquery/bigquery.adapter.js';
import {
  buildJobConfiguration,
  buildMultipartBody,
  createRestLoadJobClient,
} from '../src/bigquery/load-job.rest.js';
import { createStaticTokenProvider } from '../src/bigquery/token.js';
import { makeTempDir } from './helpers.js';

const ROW: IotRow = {
  eventId: 'evt-0',
  locationId: 'loc-lobby',
  businessDate: '2026-05-01',
  cameraId: 'cam-1',
  peopleCount: 3,
  intervalSeconds: 30,
  observedAt: '2026-05-01T10:00:00.000Z',
  receivedAt: '2026-05-01T10:00:01.000Z',
};

interface RecordedCall {
  readonly table: string;
  readonly sourcePath: string;
  readonly writeDisposition: string;
  readonly schema: readonly ColumnSchema[];
}

function createRecordingClient(): { client: LoadJobClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    client: {
      async loadNdjson(options): Promise<void> {
        calls.push({
          table: options.table,
          sourcePath: options.sourcePath,
          writeDisposition: options.writeDisposition,
          schema: options.schema,
        });
      },
    },
  };
}

test('one batch becomes exactly one load job', async () => {
  const { client, calls } = createRecordingClient();
  const adapter = createBigQueryAdapter({
    client,
    table: 'fact_camera_events',
    tempDir: makeTempDir(),
  });

  await adapter.insertBatch([ROW, { ...ROW, eventId: 'evt-1' }]);

  assert.equal(calls.length, 1, 'must be one load job, not one per row');
  assert.equal(calls[0]?.table, 'fact_camera_events');
  assert.equal(calls[0]?.writeDisposition, 'WRITE_APPEND');
});

test('the load job carries all eight fact_camera_events columns with explicit types', async () => {
  const { client, calls } = createRecordingClient();
  const adapter = createBigQueryAdapter({
    client,
    table: 'fact_camera_events',
    tempDir: makeTempDir(),
  });

  await adapter.insertBatch([ROW]);

  const schema = calls[0]?.schema ?? [];
  assert.deepEqual(
    schema.map((column) => column.name),
    [
      'event_id',
      'location_id',
      'business_date',
      'camera_id',
      'observed_at',
      'received_at',
      'people_count',
      'interval_seconds',
    ],
  );
  assert.equal(schema.find((column) => column.name === 'business_date')?.type, 'DATE');
  assert.equal(schema.find((column) => column.name === 'interval_seconds')?.mode, 'REQUIRED');
  assert.equal(schema.find((column) => column.name === 'camera_id')?.mode, 'NULLABLE');
  assert.equal(FACT_CAMERA_EVENT_COLUMNS.length, 8);
});

test('the NDJSON row is snake_case and carries the Makassar business date', () => {
  const lines = serializeNdjson([ROW]).trim().split('\n');

  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;

  assert.deepEqual(Object.keys(parsed).sort(), [
    'business_date',
    'camera_id',
    'event_id',
    'interval_seconds',
    'location_id',
    'observed_at',
    'people_count',
    'received_at',
  ]);
  assert.equal(parsed['business_date'], '2026-05-01');
  assert.equal(parsed['interval_seconds'], 30);
});

test('the temporary NDJSON file is removed after a successful load', async () => {
  const { client, calls } = createRecordingClient();
  const tempDir = makeTempDir();
  const adapter = createBigQueryAdapter({ client, table: 'fact_camera_events', tempDir });

  await adapter.insertBatch([ROW]);

  assert.equal(calls.length, 1);
  assert.equal(existsSync(calls[0]?.sourcePath ?? ''), false);
});

test('a load failure rejects AND removes the temporary file', async () => {
  const tempDir = makeTempDir();
  let captured: string | undefined;
  const adapter = createBigQueryAdapter({
    client: {
      async loadNdjson(options): Promise<void> {
        captured = options.sourcePath;
        // The file must exist while the client reads it.
        assert.equal(readFileSync(options.sourcePath, 'utf8').includes('evt-0'), true);
        throw new Error('bigquery load job failed: 403');
      },
    },
    table: 'fact_camera_events',
    tempDir,
  });

  await assert.rejects(() => adapter.insertBatch([ROW]), /403/);
  assert.equal(existsSync(captured ?? ''), false);
});

test('an empty batch performs no load job at all', async () => {
  const { client, calls } = createRecordingClient();
  const adapter = createBigQueryAdapter({
    client,
    table: 'fact_camera_events',
    tempDir: makeTempDir(),
  });

  await adapter.insertBatch([]);

  assert.equal(calls.length, 0);
});

test('the REST client posts a multipart load job with WRITE_APPEND and an explicit schema', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const client = createRestLoadJobClient({
    project: 'finns-assessment',
    dataset: 'finns_hospitality',
    tokenProvider: createStaticTokenProvider('test-token'),
    jobId: () => 'job-1',
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response('{}', { status: 200 });
    },
  });

  const tempDir = makeTempDir();
  const sourcePath = join(tempDir, 'batch.ndjson');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(sourcePath, serializeNdjson([ROW]), 'utf8');

  await client.loadNdjson({
    table: 'fact_camera_events',
    sourcePath,
    writeDisposition: 'WRITE_APPEND',
    schema: FACT_CAMERA_EVENT_COLUMNS,
  });

  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.ok(request);
  assert.match(request.url, /upload\/bigquery\/v2\/projects\/finns-assessment\/jobs/);
  assert.match(request.url, /uploadType=multipart/);

  const headers = request.init.headers as Record<string, string>;
  assert.equal(headers['Authorization'], 'Bearer test-token');
  assert.match(headers['Content-Type'] ?? '', /^multipart\/related; boundary=/);

  const body = request.init.body as Buffer;
  const asText = body.toString('utf8');
  assert.match(asText, /NEWLINE_DELIMITED_JSON/);
  assert.match(asText, /WRITE_APPEND/);
  assert.match(asText, /"autodetect":false/);
  assert.match(asText, /"business_date"/);
  assert.match(asText, /"event_id":"evt-0"/);
});

test('a non-2xx load response rejects with the status and body detail', async () => {
  const client = createRestLoadJobClient({
    project: 'p',
    dataset: 'd',
    tokenProvider: createStaticTokenProvider('t'),
    fetch: async () => new Response('{"error":{"message":"no such table"}}', { status: 404 }),
  });

  const sourcePath = join(makeTempDir(), 'batch.ndjson');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(sourcePath, '{"event_id":"x"}\n', 'utf8');

  await assert.rejects(
    () =>
      client.loadNdjson({
        table: 'fact_camera_events',
        sourcePath,
        writeDisposition: 'WRITE_APPEND',
        schema: FACT_CAMERA_EVENT_COLUMNS,
      }),
    /bigquery load job failed: 404/,
  );
});

test('the job configuration names the destination table and disables autodetect', () => {
  const config = buildJobConfiguration({
    jobId: 'job-1',
    project: 'finns-assessment',
    dataset: 'finns_hospitality',
    table: 'fact_camera_events',
    writeDisposition: 'WRITE_APPEND',
    schema: FACT_CAMERA_EVENT_COLUMNS,
    ndjson: Buffer.from(''),
  }) as { configuration: { load: Record<string, unknown> } };

  assert.deepEqual(config.configuration.load['destinationTable'], {
    projectId: 'finns-assessment',
    datasetId: 'finns_hospitality',
    tableId: 'fact_camera_events',
  });
  assert.equal(config.configuration.load['autodetect'], false);

  const multipart = buildMultipartBody({
    jobId: 'job-1',
    project: 'p',
    dataset: 'd',
    table: 't',
    writeDisposition: 'WRITE_APPEND',
    schema: FACT_CAMERA_EVENT_COLUMNS,
    ndjson: Buffer.from('{"a":1}\r\n'.replace('\r\n', '\n')),
  });
  assert.match(multipart.contentType, /boundary=finns-load-job-1/);
});
