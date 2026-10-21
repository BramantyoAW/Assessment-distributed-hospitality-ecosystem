import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { computeRetryDelayMs } from '../src/batch/batcher.js';
import type { Harness } from './helpers.js';
import { postIngest, startHarness, validPayload, waitFor } from './helpers.js';

function seed(harness: Harness, count: number): void {
  for (let index = 0; index < count; index += 1) {
    harness.repo.ingest({
      eventId: `evt-${index}`,
      locationId: 'loc-lobby',
      cameraId: 'cam-1',
      peopleCount: index,
      intervalSeconds: 30,
      observedAt: '2026-05-01T10:00:00.000Z',
    });
  }
}

test('one flush sends every due row in a single batch', async () => {
  const harness = await startHarness();
  try {
    seed(harness, 3);

    const result = await harness.batcher.flush();

    assert.deepEqual(result, { sent: 3, deadLettered: 0 });
    assert.equal(harness.adapter.batches.length, 1, 'must be one call, not three');
    assert.equal(harness.adapter.totalRows(), 3);
    assert.equal(harness.repo.countByStatus('sent'), 3);
    assert.equal(harness.repo.countByStatus('pending'), 0);

    const row = harness.adapter.batches[0]?.[0];
    assert.ok(row);
    assert.equal(row.eventId, 'evt-0');
    assert.equal(row.locationId, 'loc-lobby');
    assert.equal(row.cameraId, 'cam-1');
    assert.equal(row.peopleCount, 0);
    assert.equal(row.intervalSeconds, 30);
    assert.equal(row.businessDate, '2026-05-01', 'business date comes from Asia/Makassar');
    assert.equal(row.observedAt, '2026-05-01T10:00:00.000Z');
    assert.equal(typeof row.receivedAt, 'string');
  } finally {
    await harness.close();
  }
});

test('flush with nothing due does not call the adapter', async () => {
  const harness = await startHarness();
  try {
    const result = await harness.batcher.flush();

    assert.deepEqual(result, { sent: 0, deadLettered: 0 });
    assert.equal(harness.adapter.batches.length, 0);
  } finally {
    await harness.close();
  }
});

test('a full batch is capped at maxBatchSize and spread over flushes', async () => {
  const harness = await startHarness({ batchMaxSize: 2 });
  try {
    seed(harness, 5);

    assert.equal((await harness.batcher.flush()).sent, 2);
    assert.equal((await harness.batcher.flush()).sent, 2);
    assert.equal((await harness.batcher.flush()).sent, 1);
    assert.equal(harness.adapter.totalRows(), 5);
  } finally {
    await harness.close();
  }
});

test('a failed batch goes back to pending with attempts and error recorded', async () => {
  const harness = await startHarness();
  try {
    seed(harness, 3);
    harness.adapter.failNext('warehouse down');

    const result = await harness.batcher.flush();

    assert.deepEqual(result, { sent: 0, deadLettered: 0 });
    assert.equal(harness.repo.countByStatus('pending'), 3, 'no row may be lost');
    assert.equal(harness.repo.countByStatus('in_flight'), 0);
    assert.equal(harness.repo.countByStatus('failed'), 0);

    const row = harness.repo.findByEventId('evt-0');
    assert.ok(row);
    assert.equal(row.attempts, 1);
    assert.equal(row.lastError, 'warehouse down');
    assert.equal(row.batchId, null);
  } finally {
    await harness.close();
  }
});

test('a requeued batch is sent on the next flush', async () => {
  const harness = await startHarness();
  try {
    seed(harness, 2);
    harness.adapter.failNext();

    await harness.batcher.flush();
    assert.equal(harness.repo.countByStatus('pending'), 2);

    await harness.batcher.flush();

    assert.equal(harness.repo.countByStatus('sent'), 2);
    assert.equal(harness.adapter.totalRows(), 2, 'exactly one successful delivery');
  } finally {
    await harness.close();
  }
});

test('a batch that never succeeds ends up dead-lettered, still in the database', async () => {
  const harness = await startHarness({ batchMaxAttempts: 2 });
  try {
    seed(harness, 2);

    harness.adapter.failNext();
    assert.deepEqual(await harness.batcher.flush(), { sent: 0, deadLettered: 0 });

    harness.adapter.failNext();
    assert.deepEqual(await harness.batcher.flush(), { sent: 0, deadLettered: 2 });

    assert.equal(harness.repo.countByStatus('failed'), 2);
    assert.equal(harness.repo.countByStatus('pending'), 0);

    const dead = harness.repo.listByStatus('failed');
    assert.equal(dead.length, 2);
    assert.equal(dead[0]?.attempts, 2);
    assert.ok(dead[0]?.lastError?.includes('injected adapter failure'));
  } finally {
    await harness.close();
  }
});

test('concurrent flushes are single-flight: one batch, one adapter call', async () => {
  const harness = await startHarness();
  try {
    seed(harness, 3);

    const first = harness.batcher.flush();
    const second = harness.batcher.flush();

    assert.ok(first === second, 'the second caller must join the in-flight flush');
    await first;

    assert.equal(harness.adapter.batches.length, 1);
    assert.equal(harness.adapter.totalRows(), 3);
  } finally {
    await harness.close();
  }
});

test('the size trigger flushes without waiting for the interval', async () => {
  const harness = await startHarness({ batchMaxSize: 2 });
  try {
    await postIngest(harness.url, validPayload({ eventId: 'evt-a' }));
    assert.equal(harness.adapter.totalRows(), 0);

    await postIngest(harness.url, validPayload({ eventId: 'evt-b' }));

    await waitFor(() => harness.adapter.totalRows() === 2);
    assert.equal(harness.adapter.batches.length, 1);
  } finally {
    await harness.close();
  }
});

test('the timer flushes buffered rows', async () => {
  const harness = await startHarness({ batchIntervalMs: 100 });
  try {
    seed(harness, 2);
    harness.batcher.start();

    await waitFor(() => harness.repo.countByStatus('sent') === 2);
    assert.equal(harness.adapter.totalRows(), 2);
  } finally {
    await harness.close();
  }
});

test('stop drains buffered rows instead of waiting for the timer', async () => {
  const harness = await startHarness({ batchIntervalMs: 3_600_000 });
  try {
    seed(harness, 4);

    await harness.batcher.stop();

    assert.equal(harness.repo.countByStatus('sent'), 4);
    assert.equal(harness.adapter.totalRows(), 4);
  } finally {
    await harness.close();
  }
});

test('rows stranded in flight by a dead process are recovered and delivered', async () => {
  const harness = await startHarness();
  try {
    seed(harness, 2);

    const claimed = harness.repo.claimBatch('abandoned-batch', 10);
    assert.equal(claimed.length, 2);
    assert.equal(harness.repo.countByStatus('in_flight'), 2);

    assert.equal(harness.repo.reclaimInFlight(), 2);
    assert.equal(harness.repo.countByStatus('pending'), 2);

    assert.equal((await harness.batcher.flush()).sent, 2);
    assert.equal(harness.adapter.totalRows(), 2);
  } finally {
    await harness.close();
  }
});

test('batch retry delay grows exponentially and is capped', () => {
  assert.equal(computeRetryDelayMs(1, 1_000, 60_000, 0), 1_000);
  assert.equal(computeRetryDelayMs(3, 1_000, 60_000, 0), 4_000);
  assert.equal(computeRetryDelayMs(20, 1_000, 60_000, 0), 60_000);
  assert.equal(computeRetryDelayMs(2, 0, 60_000, 0.5), 0);
});
