import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createMemoryGateway } from '../src/bigquery/memory.gateway.js';
import type { CameraEventFact, TransactionFact } from '../src/bigquery/gateway.js';

const DATE = '2026-05-01';
const LOCATION = 'loc-beach-club';

function transaction(overrides: Partial<TransactionFact> & { transactionId: string }): TransactionFact {
  return {
    locationId: LOCATION,
    businessDate: DATE,
    occurredAt: null,
    occurredAtSource: 'unavailable',
    sourceCreatedAt: '2026-05-01T00:00:00.000Z',
    sourceModifiedAt: '2026-05-01T00:00:00.000Z',
    amount: '100.00',
    currency: 'IDR',
    txnType: 'fnb',
    guests: 2,
    sourceSystem: 'netsuite',
    ingestedAt: '2026-05-01T01:00:00.000Z',
    ...overrides,
  };
}

function cameraEvent(
  overrides: Partial<CameraEventFact> & { eventId: string },
): CameraEventFact {
  return {
    locationId: LOCATION,
    businessDate: DATE,
    cameraId: 'cam-1',
    observedAt: '2026-05-01T10:00:00.000Z',
    receivedAt: '2026-05-01T10:00:01.000Z',
    peopleCount: 10,
    intervalSeconds: 30,
    ...overrides,
  };
}

/** 3 transactions (100 + 200 + 300) and 2 readings (10 + 15 people). */
async function seed(): Promise<ReturnType<typeof createMemoryGateway>> {
  const gateway = createMemoryGateway();
  await gateway.insertTransactions([
    transaction({ transactionId: 't-1', amount: '100.00' }),
    transaction({ transactionId: 't-2', amount: '200.00' }),
    transaction({ transactionId: 't-3', amount: '300.00' }),
  ]);
  await gateway.insertCameraEvents([
    cameraEvent({ eventId: 'e-1', peopleCount: 10 }),
    cameraEvent({ eventId: 'e-2', peopleCount: 15 }),
  ]);
  return gateway;
}

test('aggregate before join: 3 transactions and 2 readings give 0.12, not 0.04', async () => {
  const gateway = await seed();

  const [record] = await gateway.conversionMetrics([
    { locationId: LOCATION, businessDate: DATE },
  ]);

  assert.ok(record);
  assert.equal(record.totalTransactions, 3);
  assert.equal(record.totalRevenue, '600.00', 'revenue must not be multiplied by readings');
  assert.equal(record.totalVisits, 25);
  assert.equal(record.totalReadings, 2);
  assert.equal(record.cameraSeconds, 60);
  assert.equal(record.conversionRate, 0.12);
});

test('the naive join numbers are not what the gateway returns', async () => {
  const gateway = await seed();
  const [record] = await gateway.conversionMetrics([
    { locationId: LOCATION, businessDate: DATE },
  ]);

  assert.ok(record);
  // Documented anti-fixture: joining the facts first produces these.
  assert.notEqual(record.conversionRate, 0.04);
  assert.notEqual(record.totalRevenue, '1200.00');
  assert.notEqual(record.totalVisits, 75);
});

test('a replayed batch does not double the revenue', async () => {
  const gateway = await seed();
  await gateway.insertTransactions([
    transaction({ transactionId: 't-1', amount: '100.00', ingestedAt: '2026-05-02T00:00:00.000Z' }),
    transaction({ transactionId: 't-2', amount: '200.00', ingestedAt: '2026-05-02T00:00:00.000Z' }),
    transaction({ transactionId: 't-3', amount: '300.00', ingestedAt: '2026-05-02T00:00:00.000Z' }),
  ]);

  const [record] = await gateway.conversionMetrics([
    { locationId: LOCATION, businessDate: DATE },
  ]);

  assert.ok(record);
  assert.equal(record.totalTransactions, 3);
  assert.equal(record.totalRevenue, '600.00');
});

test('a stale version arriving last does not overwrite the corrected amount', async () => {
  const gateway = createMemoryGateway();
  await gateway.insertTransactions([
    transaction({
      transactionId: 't-1',
      amount: '100.00',
      sourceModifiedAt: '2026-05-01T10:00:00.000Z',
      ingestedAt: '2026-05-01T10:00:01.000Z',
    }),
    // Older source version, loaded later: it must lose.
    transaction({
      transactionId: 't-1',
      amount: '999.00',
      sourceModifiedAt: '2026-05-01T09:00:00.000Z',
      ingestedAt: '2026-05-01T11:00:00.000Z',
    }),
  ]);

  const [record] = await gateway.conversionMetrics([
    { locationId: LOCATION, businessDate: DATE },
  ]);

  assert.ok(record);
  assert.equal(record.totalRevenue, '100.00');
});

test('without camera data the conversion rate is null, not zero', async () => {
  const gateway = createMemoryGateway();
  await gateway.insertTransactions([transaction({ transactionId: 't-1', amount: '100.00' })]);

  const [record] = await gateway.conversionMetrics([
    { locationId: LOCATION, businessDate: DATE },
  ]);

  assert.ok(record);
  assert.equal(record.totalVisits, 0);
  assert.equal(record.conversionRate, null, 'null means "not measurable", 0 means "nobody converted"');
});

test('a day with cameras but no transactions is 0 percent, not null', async () => {
  const gateway = createMemoryGateway();
  await gateway.insertCameraEvents([cameraEvent({ eventId: 'e-1', peopleCount: 10 })]);

  const [record] = await gateway.conversionMetrics([
    { locationId: LOCATION, businessDate: DATE },
  ]);

  assert.ok(record);
  assert.equal(record.totalTransactions, 0);
  assert.equal(record.conversionRate, 0);
});

test('decimal revenue is exact: no floating point drift', async () => {
  const gateway = createMemoryGateway();
  await gateway.insertTransactions([
    transaction({ transactionId: 't-1', amount: '0.10' }),
    transaction({ transactionId: 't-2', amount: '0.20' }),
  ]);

  const [record] = await gateway.conversionMetrics([
    { locationId: LOCATION, businessDate: DATE },
  ]);

  assert.ok(record);
  assert.equal(record.totalRevenue, '0.30');
});

test('every requested key is returned, and an empty key list performs no work', async () => {
  const gateway = await seed();

  const records = await gateway.conversionMetrics([
    { locationId: LOCATION, businessDate: DATE },
    { locationId: 'loc-nowhere', businessDate: DATE },
  ]);

  assert.equal(records.length, 1, 'a location with no data is absent, not zero-filled');
  assert.deepEqual(records[0]?.locationId, LOCATION);

  assert.deepEqual(await gateway.conversionMetrics([]), []);
});

test('visitor counts aggregate per hour in the venue timezone', async () => {
  const gateway = createMemoryGateway();
  await gateway.insertCameraEvents([
    cameraEvent({ eventId: 'e-1', peopleCount: 10, observedAt: '2026-05-01T10:00:00.000Z' }),
    cameraEvent({ eventId: 'e-2', peopleCount: 5, observedAt: '2026-05-01T10:30:00.000Z' }),
    cameraEvent({ eventId: 'e-3', peopleCount: 7, observedAt: '2026-05-01T11:05:00.000Z' }),
  ]);

  const buckets = await gateway.visitorCounts({
    locationId: LOCATION,
    from: DATE,
    to: DATE,
    bucket: 'HOUR',
    limit: 100,
  });

  assert.equal(buckets.length, 2);
  assert.equal(buckets[0]?.bucketStart, '2026-05-01T18:00:00+08:00');
  assert.equal(buckets[0]?.visits, 15);
  assert.equal(buckets[1]?.visits, 7);
});
