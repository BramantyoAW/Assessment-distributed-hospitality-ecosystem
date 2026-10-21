import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { NetsuiteClient, SendOutcome } from '../src/netsuite/client.js';
import { OperaEventsRepo } from '../src/queue/events.repo.js';
import { computeBackoffMs, createOperaWorker } from '../src/queue/worker.js';
import { silentLogger } from './helpers.js';

const PAYLOAD = Buffer.from('{"eventId":"evt-1","amount":100}', 'utf8');

function stubClient(
  handler: (eventId: string, payload: Buffer) => SendOutcome | Promise<SendOutcome>,
): NetsuiteClient {
  return {
    send: async (eventId, payload) => handler(eventId, payload),
  };
}

function makeRepo(maxAttempts = 3): OperaEventsRepo {
  return new OperaEventsRepo(':memory:', { maxAttempts });
}

function makeWorker(repo: OperaEventsRepo, client: NetsuiteClient) {
  return createOperaWorker({
    repo,
    client,
    logger: silentLogger(),
    pollIntervalMs: 10,
    // Zero backoff so a retry is immediately due and tests stay deterministic.
    retryBaseMs: 0,
    retryMaxDelayMs: 0,
    shutdownGraceMs: 50,
  });
}

test('a queued event is delivered once with identical bytes and marked completed', async () => {
  const repo = makeRepo();
  const received: Array<{ eventId: string; payload: Buffer }> = [];

  try {
    repo.enqueue('evt-1', PAYLOAD);

    const worker = makeWorker(
      repo,
      stubClient((eventId, payload) => {
        received.push({ eventId, payload });
        return { ok: true, status: 201, retryable: false };
      }),
    );

    assert.equal(await worker.runOnce(), 1);

    const stored = repo.findByEventId('evt-1');
    assert.ok(stored);
    assert.equal(stored.status, 'completed');
    assert.equal(stored.attempts, 0);
    assert.equal(received.length, 1);
    assert.equal(received[0]?.eventId, 'evt-1');
    assert.ok(received[0]?.payload.equals(PAYLOAD), 'delivered bytes must equal stored bytes');
  } finally {
    repo.close();
  }
});

test('a completed event is never sent a second time', async () => {
  const repo = makeRepo();
  let calls = 0;

  try {
    repo.enqueue('evt-1', PAYLOAD);
    const worker = makeWorker(
      repo,
      stubClient(() => {
        calls += 1;
        return { ok: true, status: 201, retryable: false };
      }),
    );

    await worker.runOnce();
    assert.equal(await worker.runOnce(), 0);
    assert.equal(calls, 1);
  } finally {
    repo.close();
  }
});

test('a retryable failure schedules a retry and then succeeds', async () => {
  const repo = makeRepo();
  let calls = 0;

  try {
    repo.enqueue('evt-1', PAYLOAD);
    const worker = makeWorker(
      repo,
      stubClient(() => {
        calls += 1;
        if (calls === 1) {
          return { ok: false, status: 503, retryable: true, error: 'HTTP 503' };
        }
        return { ok: true, status: 201, retryable: false };
      }),
    );

    await worker.runOnce();

    const afterFailure = repo.findByEventId('evt-1');
    assert.ok(afterFailure);
    assert.equal(afterFailure.status, 'pending');
    assert.equal(afterFailure.attempts, 1);
    assert.ok(afterFailure.lastError?.includes('503'));

    await worker.runOnce();

    const afterRetry = repo.findByEventId('evt-1');
    assert.ok(afterRetry);
    assert.equal(afterRetry.status, 'completed');
    assert.equal(calls, 2);
  } finally {
    repo.close();
  }
});

test('retries stop at maxAttempts and the event ends as failed, not lost', async () => {
  const repo = makeRepo(2);
  let calls = 0;

  try {
    repo.enqueue('evt-1', PAYLOAD);
    const worker = makeWorker(
      repo,
      stubClient(() => {
        calls += 1;
        return { ok: false, status: 500, retryable: true, error: 'HTTP 500' };
      }),
    );

    await worker.runOnce();
    assert.equal(repo.findByEventId('evt-1')?.status, 'pending');

    await worker.runOnce();

    const stored = repo.findByEventId('evt-1');
    assert.ok(stored);
    assert.equal(stored.status, 'failed');
    assert.equal(stored.attempts, 2);
    assert.ok(stored.lastError?.includes('2/2'));
    assert.equal(calls, 2);
  } finally {
    repo.close();
  }
});

test('a non-retryable 4xx fails immediately without burning attempts', async () => {
  const repo = makeRepo(5);
  let calls = 0;

  try {
    repo.enqueue('evt-1', PAYLOAD);
    const worker = makeWorker(
      repo,
      stubClient(() => {
        calls += 1;
        return { ok: false, status: 422, retryable: false, error: 'HTTP 422' };
      }),
    );

    await worker.runOnce();

    const stored = repo.findByEventId('evt-1');
    assert.ok(stored);
    assert.equal(stored.status, 'failed');
    assert.equal(stored.attempts, 1);
    assert.equal(calls, 1);
  } finally {
    repo.close();
  }
});

test('a thrown client error is treated as retryable instead of crashing the worker', async () => {
  const repo = makeRepo(3);
  let calls = 0;

  try {
    repo.enqueue('evt-1', PAYLOAD);
    const worker = makeWorker(
      repo,
      stubClient(() => {
        calls += 1;
        throw new Error('socket hang up');
      }),
    );

    await worker.runOnce();

    const stored = repo.findByEventId('evt-1');
    assert.ok(stored);
    assert.equal(stored.status, 'pending');
    assert.equal(stored.attempts, 1);
    assert.ok(stored.lastError?.includes('socket hang up'));
    assert.equal(calls, 1);
  } finally {
    repo.close();
  }
});

test('rows left in processing by a dead process are reclaimed', () => {
  const repo = makeRepo();
  try {
    repo.enqueue('evt-1', PAYLOAD);
    const claimed = repo.claimDue(new Date(), 10);
    assert.equal(claimed.length, 1);

    assert.equal(repo.countByStatus('processing'), 1);
    assert.equal(repo.reclaimStale(), 1);
    assert.equal(repo.countByStatus('pending'), 1);
    assert.equal(repo.countByStatus('processing'), 0);
  } finally {
    repo.close();
  }
});

test('backoff grows exponentially, is capped, and adds jitter', () => {
  assert.equal(computeBackoffMs(1, 500, 30_000, 0), 500);
  assert.equal(computeBackoffMs(2, 500, 30_000, 0), 1_000);
  assert.equal(computeBackoffMs(5, 500, 30_000, 0), 8_000);
  assert.equal(computeBackoffMs(10, 500, 30_000, 0), 30_000);

  // A zero base means "retry immediately" (used by tests and by operators).
  assert.equal(computeBackoffMs(3, 0, 30_000, 0.5), 0);

  // Jitter is additive and bounded.
  const jittered = computeBackoffMs(1, 500, 30_000, 1);
  assert.ok(jittered >= 500 && jittered <= 750);
});
