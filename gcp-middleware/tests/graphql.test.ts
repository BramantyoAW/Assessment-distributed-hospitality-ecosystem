import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { graphql } from 'graphql';

import type { BigQueryGateway, CameraEventFact, TransactionFact } from '../src/bigquery/gateway.js';
import { createMemoryGateway } from '../src/bigquery/memory.gateway.js';
import { createLoaders } from '../src/dataloader/loaders.js';
import { assertDepth, MAX_DEPTH } from '../src/schema/guard.js';
import { createSchema } from '../src/schema/index.js';
import { MAX_LIMIT, clampLimit } from '../src/schema/resolvers.js';

const DATE = '2026-05-01';
const LOCATION = 'loc-beach-club';

function transaction(id: string, overrides: Partial<TransactionFact> = {}): TransactionFact {
  return {
    transactionId: id,
    locationId: LOCATION,
    businessDate: DATE,
    occurredAt: null,
    occurredAtSource: 'unavailable',
    sourceCreatedAt: '2026-05-01T00:00:00.000Z',
    sourceModifiedAt: '2026-05-01T00:00:00.000Z',
    amount: '100.00',
    currency: 'IDR',
    txnType: 'fnb',
    guests: null,
    sourceSystem: 'netsuite',
    ingestedAt: '2026-05-01T01:00:00.000Z',
    ...overrides,
  };
}

function cameraEvent(id: string, peopleCount: number): CameraEventFact {
  return {
    eventId: id,
    locationId: LOCATION,
    businessDate: DATE,
    cameraId: 'cam-1',
    observedAt: '2026-05-01T10:00:00.000Z',
    receivedAt: '2026-05-01T10:00:01.000Z',
    peopleCount,
    intervalSeconds: 30,
  };
}

interface Counted {
  readonly gateway: BigQueryGateway;
  readonly calls: Record<string, number>;
}

function counted(memory: BigQueryGateway): Counted {
  const calls: Record<string, number> = {};
  const bump = (name: string): void => {
    calls[name] = (calls[name] ?? 0) + 1;
  };

  return {
    calls,
    gateway: {
      ...memory,
      listLocations: async () => {
        bump('listLocations');
        return memory.listLocations();
      },
      conversionMetrics: async (keys) => {
        bump('conversionMetrics');
        return memory.conversionMetrics(keys);
      },
      listTransactions: async (query) => {
        bump('listTransactions');
        return memory.listTransactions(query);
      },
      visitorCounts: async (query) => {
        bump('visitorCounts');
        return memory.visitorCounts(query);
      },
    },
  };
}

async function run(
  gateway: BigQueryGateway,
  source: string,
  variables?: Record<string, unknown>,
): Promise<ReturnType<typeof graphql>> {
  return graphql({
    schema: createSchema(),
    source,
    contextValue: { gateway, loaders: createLoaders(gateway) },
    variableValues: variables,
  });
}

async function seeded(): Promise<Counted> {
  const memory = createMemoryGateway();
  await memory.insertTransactions([
    transaction('t-1', { amount: '100.00' }),
    transaction('t-2', { amount: '200.00' }),
    transaction('t-3', { amount: '300.00' }),
  ]);
  await memory.insertCameraEvents([cameraEvent('e-1', 10), cameraEvent('e-2', 15)]);
  return counted(memory);
}

test('the schema exposes the four locations from the seed', async () => {
  const { gateway } = await seeded();
  const result = await run(gateway, '{ locations { id name isOutdoor timezone } }');

  assert.equal(result.errors, undefined);
  const data = result.data as { locations: { id: string }[] };
  assert.equal(data.locations.length, 4);
});

test('guests stays null and amount stays a decimal string', async () => {
  const { gateway } = await seeded();
  const result = await run(
    gateway,
    `{ transactions(locationId: "${LOCATION}", from: "${DATE}", to: "${DATE}") { id guests amount occurredAt occurredAtSource } }`,
  );

  assert.equal(result.errors, undefined);
  const data = result.data as {
    transactions: { id: string; guests: number | null; amount: string; occurredAt: string | null; occurredAtSource: string }[];
  };

  assert.equal(data.transactions.length, 3);
  const first = data.transactions[0];
  assert.ok(first);
  assert.equal(first.guests, null, 'null must survive as null, not become 0');
  assert.equal(first.amount, '100.00');
  assert.equal(first.occurredAt, null);
  assert.equal(first.occurredAtSource, 'UNAVAILABLE');
});

test('conversionRate per location is batched into ONE warehouse call (DataLoader)', async () => {
  const { gateway, calls } = await seeded();

  const result = await run(
    gateway,
    `{ locations { id conversionRate(date: "${DATE}") { conversionRate totalRevenue totalVisits } } }`,
  );

  assert.equal(result.errors, undefined);
  assert.equal(calls['conversionMetrics'], 1, '4 locations must not mean 4 queries');

  const data = result.data as {
    locations: { id: string; conversionRate: { conversionRate: number | null; totalRevenue: string; totalVisits: number } | null }[];
  };
  const beach = data.locations.find((row) => row.id === LOCATION);
  assert.ok(beach?.conversionRate);
  assert.equal(beach.conversionRate.conversionRate, 0.12);
  assert.equal(beach.conversionRate.totalRevenue, '600.00');
  assert.equal(beach.conversionRate.totalVisits, 25);
});

test('a location without data returns a null conversionRate rather than an error', async () => {
  const { gateway } = await seeded();
  const result = await run(gateway, `{ conversionRate(locationId: "loc-nowhere", date: "${DATE}") { conversionRate } }`);

  assert.equal(result.errors, undefined);
  assert.equal((result.data as { conversionRate: unknown }).conversionRate, null);
});

test('an unknown location id resolves to null, not an exception', async () => {
  const { gateway } = await seeded();
  const result = await run(gateway, '{ location(id: "loc-nowhere") { name } }');

  assert.equal(result.errors, undefined);
  assert.equal((result.data as { location: unknown }).location, null);
});

test('an impossible calendar date is rejected by the Date scalar', async () => {
  const { gateway } = await seeded();
  const result = await run(
    gateway,
    `{ transactions(locationId: "${LOCATION}", from: "2026-02-31", to: "${DATE}") { id } }`,
  );

  assert.ok(result.errors);
  assert.match(result.errors[0]?.message ?? '', /not a real calendar date/);
});

test('limit is clamped, not rejected', () => {
  assert.equal(clampLimit(10_000, 50), MAX_LIMIT);
  assert.equal(clampLimit(0, 50), 1);
  assert.equal(clampLimit(-5, 50), 1);
  assert.equal(clampLimit(undefined, 50), 50);
  assert.equal(clampLimit(Number.NaN, 50), 50);
  assert.equal(clampLimit(25, 50), 25);
});

test('a query deeper than the cap is refused before it reaches the warehouse', () => {
  assert.equal(assertDepth('{ locations { id } }'), 2);

  const deep = `{ location(id: "x") { conversionRate(date: "${DATE}") { location { conversionRate(date: "${DATE}") { location { conversionRate(date: "${DATE}") { location { name } } } } } } } }`;
  assert.throws(() => assertDepth(deep), /maximum is 6/);
});

test('a fragment cannot be used to slip past the depth cap', () => {
  const fragmentBomb = `
    query {
      location(id: "x") {
        ...Deep
      }
    }
    fragment Deep on Location {
      conversionRate(date: "${DATE}") {
        location { conversionRate(date: "${DATE}") { location { conversionRate(date: "${DATE}") { location { name } } } } }
      }
    }
  `;

  assert.throws(() => assertDepth(fragmentBomb, 4), /maximum is 4/);
});

test('the depth cap is deep enough for the documented query shape', () => {
  const documented = `{ locations { conversionRate(date: "${DATE}") { location { name } } } }`;
  assert.doesNotThrow(() => assertDepth(documented));
  assert.equal(MAX_DEPTH, 6);
});

test('visitor counts are exposed per bucket with visits and camera seconds', async () => {
  const { gateway } = await seeded();
  const result = await run(
    gateway,
    `{ visitorCounts(locationId: "${LOCATION}", from: "${DATE}", to: "${DATE}", bucket: HOUR) { bucketStart visits readings cameraSeconds } }`,
  );

  assert.equal(result.errors, undefined);
  const data = result.data as {
    visitorCounts: { bucketStart: string; visits: number; readings: number; cameraSeconds: number }[];
  };

  assert.equal(data.visitorCounts.length, 1);
  assert.equal(data.visitorCounts[0]?.visits, 25);
  assert.equal(data.visitorCounts[0]?.readings, 2);
  assert.equal(data.visitorCounts[0]?.cameraSeconds, 60);
});
