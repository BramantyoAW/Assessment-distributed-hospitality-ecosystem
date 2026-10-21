import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createMemoryGateway } from '../src/bigquery/memory.gateway.js';
import type { CameraEventFact, TransactionFact } from '../src/bigquery/gateway.js';
import { dedupeByKey } from '../src/ingest/dedupe.js';

interface Versioned {
  readonly id: string;
  readonly modifiedAt: string;
}

const byModified = (a: Versioned, b: Versioned): number =>
  Date.parse(a.modifiedAt) - Date.parse(b.modifiedAt);

const row = (id: string, modifiedAt: string): Versioned => ({ id, modifiedAt });

function transaction(overrides: Partial<TransactionFact> = {}): TransactionFact {
  return {
    transactionId: 'netsuite:1',
    locationId: 'lobby',
    businessDate: '2026-05-01',
    occurredAt: null,
    occurredAtSource: 'unavailable',
    sourceCreatedAt: '2026-05-01T08:00:00.000Z',
    sourceModifiedAt: '2026-05-01T09:00:00.000Z',
    amount: '100.00',
    currency: 'IDR',
    txnType: 'cash_sale',
    guests: null,
    sourceSystem: 'netsuite',
    ingestedAt: '2026-05-01T09:05:00.000Z',
    ...overrides,
  };
}

function cameraEvent(overrides: Partial<CameraEventFact> = {}): CameraEventFact {
  return {
    eventId: 'evt-1',
    locationId: 'lobby',
    businessDate: '2026-05-01',
    cameraId: 'cam-01',
    observedAt: '2026-05-01T10:00:00.000Z',
    receivedAt: '2026-05-01T10:00:01.000Z',
    peopleCount: 12,
    intervalSeconds: 30,
    ...overrides,
  };
}

test('the newer source modification wins', () => {
  const winners = dedupeByKey(
    [row('a', '2026-05-01T09:00:00Z'), row('a', '2026-05-01T10:00:00Z')],
    (r) => r.id,
    byModified,
  );

  assert.equal(winners.length, 1);
  assert.equal(winners[0]?.modifiedAt, '2026-05-01T10:00:00Z');
});

test('on a tie the later row in input order wins, so replaying a batch is idempotent', () => {
  const winners = dedupeByKey(
    [row('a', '2026-05-01T09:00:00Z'), row('a', '2026-05-01T09:00:00Z')],
    (r) => r.id,
    byModified,
  );

  assert.equal(winners.length, 1);
});

test('distinct keys are all kept, in first-seen order', () => {
  const winners = dedupeByKey(
    [row('b', '2026-05-01T09:00:00Z'), row('a', '2026-05-01T10:00:00Z')],
    (r) => r.id,
    byModified,
  );

  assert.deepEqual(
    winners.map((r) => r.id),
    ['b', 'a'],
  );
});

test('the result does not depend on input order when timestamps differ', () => {
  const forward = dedupeByKey(
    [
      row('a', '2026-05-01T09:00:00Z'),
      row('b', '2026-05-01T08:00:00Z'),
      row('a', '2026-05-01T11:00:00Z'),
      row('b', '2026-05-01T12:00:00Z'),
    ],
    (r) => r.id,
    byModified,
  );
  const backward = dedupeByKey(
    [
      row('b', '2026-05-01T12:00:00Z'),
      row('a', '2026-05-01T11:00:00Z'),
      row('b', '2026-05-01T08:00:00Z'),
      row('a', '2026-05-01T09:00:00Z'),
    ],
    (r) => r.id,
    byModified,
  );

  const pick = (rows: readonly Versioned[]): string[] =>
    rows.map((r) => `${r.id}@${r.modifiedAt}`).sort();

  assert.deepEqual(pick(forward), pick(backward));
});

test('memory gateway: an older version arriving last still loses (R2 ordering bug)', async () => {
  const gateway = createMemoryGateway();

  // The newer row lands first...
  await gateway.insertTransactions([
    transaction({ amount: '100.00', sourceModifiedAt: '2026-05-01T10:00:00Z', ingestedAt: '2026-05-01T10:05:00Z' }),
  ]);
  // ...then a stale version arrives with a LATER ingestedAt. Ordering by
  // ingestedAt alone (as R2's view did) would pick this one and lose 100.00.
  await gateway.insertTransactions([
    transaction({ amount: '999.00', sourceModifiedAt: '2026-05-01T09:00:00Z', ingestedAt: '2026-05-01T10:10:00Z' }),
  ]);

  const rows = await gateway.readTransactions();

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.amount, '100.00');
});

test('memory gateway: camera events are deduplicated by event id, newest received_at wins', async () => {
  const gateway = createMemoryGateway();

  await gateway.insertCameraEvents([
    cameraEvent({ peopleCount: 12, receivedAt: '2026-05-01T10:00:01Z' }),
    cameraEvent({ peopleCount: 15, receivedAt: '2026-05-01T10:00:09Z' }),
  ]);

  const rows = await gateway.readCameraEvents();

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.peopleCount, 15);
});

test('memory gateway: intervalSeconds and businessDate survive the round trip', async () => {
  // Both columns are mandatory in the warehouse; a gateway that drops them would
  // hide the Module 2 contract gap this project already paid for once.
  const gateway = createMemoryGateway();
  await gateway.insertCameraEvents([cameraEvent({ businessDate: '2026-05-01', intervalSeconds: 30 })]);

  const rows = await gateway.readCameraEvents();

  assert.equal(rows[0]?.businessDate, '2026-05-01');
  assert.equal(rows[0]?.intervalSeconds, 30);
});

test('memory gateway: reading before anything was written returns nothing', async () => {
  const gateway = createMemoryGateway();

  assert.deepEqual(await gateway.readTransactions(), []);
  assert.deepEqual(await gateway.readCameraEvents(), []);
});
