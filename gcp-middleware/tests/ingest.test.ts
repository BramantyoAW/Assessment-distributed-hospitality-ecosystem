import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createMemoryGateway } from '../src/bigquery/memory.gateway.js';
import type { BigQueryGateway, CheckpointRecord, TransactionFact } from '../src/bigquery/gateway.js';
import { planStart, runTransactionIngest } from '../src/ingest/transactions.job.js';
import { createLogger } from '../src/logger.js';
import type { PageRequest, PageResult, SuiteQlRow } from '../src/netsuite/client.js';

const silent = createLogger({ service: 'test', sink: () => {} });
const BOOTSTRAP = '2026-01-01T00:00:00.000Z';

function row(id: string, modified: string, location = '2'): SuiteQlRow {
  return {
    id,
    trandate: '2026-04-30',
    amount: '100.00',
    currency: 'IDR',
    type: 'Cash Sale',
    location,
    lastmodifieddate: modified,
  };
}

function fakeClient(pages: readonly SuiteQlRow[][], hasMore = false): {
  fetchTransactionPage: (request: PageRequest) => Promise<PageResult>;
  requests: PageRequest[];
} {
  const requests: PageRequest[] = [];
  let index = 0;

  return {
    requests,
    fetchTransactionPage: async (request) => {
      requests.push(request);
      const rows = pages[index] ?? [];
      index += 1;
      return { rows, hasMore: hasMore && rows.length > 0 };
    },
  };
}

interface Recorder {
  readonly gateway: BigQueryGateway;
  readonly loaded: TransactionFact[];
  readonly checkpoints: CheckpointRecord[];
}

function recorderGateway(): Recorder {
  const memory = createMemoryGateway();
  const loaded: TransactionFact[] = [];
  const checkpoints: CheckpointRecord[] = [];

  return {
    loaded,
    checkpoints,
    gateway: {
      ...memory,
      insertTransactions: async (rows) => {
        loaded.push(...rows);
        await memory.insertTransactions(rows);
      },
      appendCheckpoint: async (record) => {
        checkpoints.push(record);
        await memory.appendCheckpoint(record);
      },
    },
  };
}

test('the first run starts at the configured floor, not at "all history"', () => {
  const plan = planStart({
    checkpoint: null,
    lookbackMinutes: 10,
    bootstrapSince: BOOTSTRAP,
    now: new Date('2026-05-01T00:00:00Z'),
  });

  assert.equal(plan.sinceIso, BOOTSTRAP);
});

test('a stored cursor is re-read from before itself, not from exactly itself', () => {
  const plan = planStart({
    checkpoint: {
      stream: 'transactions',
      cursorModifiedAt: '2026-05-01T10:00:00.000Z',
      cursorId: '900',
      overlapMinutes: 10,
      runStartedAt: BOOTSTRAP,
      pages: 1,
      rowsLoaded: 1,
      rowsRejected: 0,
      writtenAt: '2026-05-01T10:05:00.000Z',
    },
    lookbackMinutes: 10,
    bootstrapSince: BOOTSTRAP,
    now: new Date('2026-05-01T12:00:00Z'),
  });

  assert.equal(plan.sinceIso, '2026-05-01T09:50:00.000Z');
});

test('a cursor in the future is clamped to now rather than trusted', () => {
  const plan = planStart({
    checkpoint: {
      stream: 'transactions',
      cursorModifiedAt: '2026-06-01T10:00:00.000Z',
      cursorId: '900',
      overlapMinutes: 0,
      runStartedAt: BOOTSTRAP,
      pages: 1,
      rowsLoaded: 1,
      rowsRejected: 0,
      writtenAt: '2026-06-01T10:05:00.000Z',
    },
    lookbackMinutes: 0,
    bootstrapSince: BOOTSTRAP,
    now: new Date('2026-05-01T12:00:00Z'),
  });

  assert.equal(plan.sinceIso, '2026-05-01T12:00:00.000Z');
});

test('an unparseable cursor fails the run instead of silently restarting', () => {
  assert.throws(
    () =>
      planStart({
        checkpoint: {
          stream: 'transactions',
          cursorModifiedAt: 'yesterday',
          cursorId: '900',
          overlapMinutes: 10,
          runStartedAt: BOOTSTRAP,
          pages: 1,
          rowsLoaded: 1,
          rowsRejected: 0,
          writtenAt: '2026-05-01T10:05:00.000Z',
        },
        lookbackMinutes: 10,
        bootstrapSince: BOOTSTRAP,
        now: new Date('2026-05-01T12:00:00Z'),
      }),
    /unparseable cursor/,
  );
});

test('one page loads the accepted rows, counts the rejections, and stores the cursor', async () => {
  const client = fakeClient([
    [
      row('1', '2026-05-01T10:00:00Z'),
      row('2', '2026-05-01T10:01:00Z', 'unknown-location'),
    ],
  ]);
  const recorder = recorderGateway();

  const summary = await runTransactionIngest({
    client,
    gateway: recorder.gateway,
    logger: silent,
    pageSize: 200,
    maxPages: 10,
    lookbackMinutes: 10,
    bootstrapSince: BOOTSTRAP,
    resolveLocationId: (raw) => (String(raw) === '2' ? 'loc-pool' : null),
  });

  assert.equal(summary.pages, 1);
  assert.equal(summary.rowsRead, 2);
  assert.equal(summary.rowsLoaded, 1);
  assert.equal(summary.rowsRejected, 1);
  assert.deepEqual(summary.rejections, { unknown_location: 1 });

  assert.equal(recorder.loaded.length, 1);
  assert.equal(recorder.checkpoints.length, 1);
  assert.equal(recorder.checkpoints[0]?.cursorId, '2', 'cursor comes from the last raw row');
  assert.equal(recorder.checkpoints[0]?.cursorModifiedAt, '2026-05-01T10:01:00.000Z');
});

test('a page of only rejected rows still advances the cursor', async () => {
  const client = fakeClient([[row('5', '2026-05-01T11:00:00Z', 'nowhere')]]);
  const recorder = recorderGateway();

  const summary = await runTransactionIngest({
    client,
    gateway: recorder.gateway,
    logger: silent,
    pageSize: 200,
    maxPages: 10,
    lookbackMinutes: 10,
    bootstrapSince: BOOTSTRAP,
    resolveLocationId: () => null,
  });

  assert.equal(summary.rowsLoaded, 0);
  assert.equal(summary.rowsRejected, 1);
  assert.equal(recorder.checkpoints.length, 1, 'otherwise the same page is re-read forever');
  assert.equal(recorder.checkpoints[0]?.cursorId, '5');
});

test('paging stops at hasMore=false and respects maxPages', async () => {
  const client = fakeClient([[row('1', '2026-05-01T10:00:00Z')], [row('2', '2026-05-01T10:01:00Z')]], true);
  const recorder = recorderGateway();

  const summary = await runTransactionIngest({
    client,
    gateway: recorder.gateway,
    logger: silent,
    pageSize: 1,
    maxPages: 1,
    lookbackMinutes: 10,
    bootstrapSince: BOOTSTRAP,
    resolveLocationId: () => 'loc-pool',
  });

  assert.equal(summary.pages, 1);
  assert.equal(client.requests.length, 1);
  assert.equal(summary.cursor?.id, '1');
});

test('a second run reads from the stored checkpoint minus the overlap', async () => {
  const recorder = recorderGateway();
  const client = fakeClient([[row('1', '2026-05-01T10:00:00Z')]]);

  await runTransactionIngest({
    client,
    gateway: recorder.gateway,
    logger: silent,
    pageSize: 200,
    maxPages: 10,
    lookbackMinutes: 10,
    bootstrapSince: BOOTSTRAP,
    resolveLocationId: () => 'loc-pool',
    now: () => new Date('2026-05-01T10:05:00Z'),
  });

  const second = fakeClient([[]]);
  await runTransactionIngest({
    client: second,
    gateway: recorder.gateway,
    logger: silent,
    pageSize: 200,
    maxPages: 10,
    lookbackMinutes: 10,
    bootstrapSince: BOOTSTRAP,
    resolveLocationId: () => 'loc-pool',
    now: () => new Date('2026-05-02T10:05:00Z'),
  });

  assert.equal(second.requests[0]?.sinceIso, '2026-05-01T09:50:00.000Z');
});

test('an empty first run writes no checkpoint', async () => {
  const client = fakeClient([[]]);
  const recorder = recorderGateway();

  const summary = await runTransactionIngest({
    client,
    gateway: recorder.gateway,
    logger: silent,
    pageSize: 200,
    maxPages: 10,
    lookbackMinutes: 10,
    bootstrapSince: BOOTSTRAP,
    resolveLocationId: () => 'loc-pool',
  });

  assert.equal(summary.pages, 0);
  assert.equal(summary.cursor, null);
  assert.equal(recorder.checkpoints.length, 0);
});
