import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import type { IotRow } from '../src/bigquery/adapter.js';
import { createJsonlAdapter } from '../src/bigquery/jsonl.adapter.js';
import { makeTempDir } from './helpers.js';

const ROWS: IotRow[] = [
  {
    eventId: 'evt-0',
    locationId: 'loc-lobby',
    businessDate: '2026-05-01',
    cameraId: 'cam-1',
    peopleCount: 3,
    intervalSeconds: 30,
    observedAt: '2026-05-01T10:00:00.000Z',
    receivedAt: '2026-05-01T10:00:01.000Z',
  },
  {
    eventId: 'evt-1',
    locationId: 'loc-pool',
    businessDate: '2026-05-01',
    cameraId: null,
    peopleCount: 17,
    intervalSeconds: 60,
    observedAt: '2026-05-01T10:00:02.000Z',
    receivedAt: '2026-05-01T10:00:03.000Z',
  },
];

function readLines(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '');
}

test('writes one valid JSON object per row, with an insertion stamp', async () => {
  const sinkPath = join(makeTempDir(), 'nested', 'sink.jsonl');
  const adapter = createJsonlAdapter({
    sinkPath,
    now: () => Date.parse('2026-05-01T10:00:05.000Z'),
  });

  await adapter.insertBatch(ROWS);

  const lines = readLines(sinkPath);
  assert.equal(lines.length, 2);

  const first = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
  assert.equal(first['eventId'], 'evt-0');
  assert.equal(first['locationId'], 'loc-lobby');
  assert.equal(first['peopleCount'], 3);
  assert.equal(first['businessDate'], '2026-05-01');
  assert.equal(first['intervalSeconds'], 30);
  assert.equal(first['insertedAt'], '2026-05-01T10:00:05.000Z');

  const second = JSON.parse(lines[1] ?? '{}') as Record<string, unknown>;
  assert.equal(second['cameraId'], null, 'a missing cameraId must survive as null, not vanish');
});

test('a second batch is appended, never truncating the sink', async () => {
  const sinkPath = join(makeTempDir(), 'sink.jsonl');
  const adapter = createJsonlAdapter({ sinkPath });

  await adapter.insertBatch([ROWS[0] as IotRow]);
  await adapter.insertBatch([ROWS[1] as IotRow]);

  assert.equal(readLines(sinkPath).length, 2);
});

test('an empty batch writes nothing at all', async () => {
  const sinkPath = join(makeTempDir(), 'sink.jsonl');
  const adapter = createJsonlAdapter({ sinkPath });

  await adapter.insertBatch([]);

  assert.equal(existsSync(sinkPath), false);
});

test('a write failure rejects, which is what lets the batcher requeue the rows', async () => {
  // /dev/null is a file, so it cannot be a parent directory: mkdirSync fails.
  const adapter = createJsonlAdapter({ sinkPath: '/dev/null/not-a-directory/sink.jsonl' });

  await assert.rejects(() => adapter.insertBatch(ROWS));
});
