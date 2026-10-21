import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createMockNetsuite } from '../mock-netsuite/server.js';
import { createNetsuiteClient } from '../src/netsuite/client.js';
import { OperaEventsRepo } from '../src/queue/events.repo.js';
import { createOperaWorker } from '../src/queue/worker.js';
import { createTestConfig, listen, silentLogger } from './helpers.js';

/**
 * Integration tests against the real mock server. Without these, the unit tests
 * would only prove that two pieces of code agree with each other.
 */

const SECRET = 'shared-secret';

function makeWorker(repo: OperaEventsRepo, client: ReturnType<typeof createNetsuiteClient>) {
  return createOperaWorker({
    repo,
    client,
    logger: silentLogger(),
    pollIntervalMs: 10,
    retryBaseMs: 0,
    retryMaxDelayMs: 0,
    shutdownGraceMs: 50,
  });
}

test('the mock accepts a delivery whose signature it can verify', async () => {
  const mock = createMockNetsuite({ hmacSecret: SECRET });
  const server = await listen(mock.app);
  const repo = new OperaEventsRepo(':memory:', { maxAttempts: 3 });

  try {
    const client = createNetsuiteClient(
      createTestConfig({
        hmacSecret: SECRET,
        netsuiteUrl: `${server.url}/api/v1/opera/events`,
      }),
    );
    const worker = makeWorker(repo, client);

    // Ugly formatting on purpose: the signature covers these exact bytes.
    const payload = Buffer.from('{\n  "eventId" : "evt-int-1",\n  "amount" : 100\n}', 'utf8');
    repo.enqueue('evt-int-1', payload);

    assert.equal(await worker.runOnce(), 1);

    const stored = repo.findByEventId('evt-int-1');
    assert.ok(stored);
    assert.equal(stored.status, 'completed');
    assert.equal(mock.state.received, 1);
    assert.equal(mock.state.rejected, 0);
    assert.equal(mock.state.duplicate, 0);
    assert.equal(mock.state.lastBody, payload.toString('utf8'));
  } finally {
    repo.close();
    await server.close();
  }
});

test('the mock rejects a signature produced with the wrong secret', async () => {
  const mock = createMockNetsuite({ hmacSecret: SECRET });
  const server = await listen(mock.app);
  const repo = new OperaEventsRepo(':memory:', { maxAttempts: 3 });

  try {
    const client = createNetsuiteClient(
      createTestConfig({
        hmacSecret: 'wrong-secret',
        netsuiteUrl: `${server.url}/api/v1/opera/events`,
      }),
    );
    const worker = makeWorker(repo, client);

    repo.enqueue('evt-int-bad', Buffer.from('{"eventId":"evt-int-bad"}', 'utf8'));
    await worker.runOnce();

    const stored = repo.findByEventId('evt-int-bad');
    assert.ok(stored);
    // 401 is not retryable, so it fails immediately instead of looping.
    assert.equal(stored.status, 'failed');
    assert.equal(mock.state.received, 0);
    assert.equal(mock.state.rejected, 1);
  } finally {
    repo.close();
    await server.close();
  }
});

test('a 503 from the mock is retried and the event still completes', async () => {
  const mock = createMockNetsuite({ hmacSecret: SECRET, failMode: 'once' });
  const server = await listen(mock.app);
  const repo = new OperaEventsRepo(':memory:', { maxAttempts: 3 });

  try {
    const client = createNetsuiteClient(
      createTestConfig({
        hmacSecret: SECRET,
        netsuiteUrl: `${server.url}/api/v1/opera/events`,
      }),
    );
    const worker = makeWorker(repo, client);

    repo.enqueue('evt-int-2', Buffer.from('{"eventId":"evt-int-2"}', 'utf8'));

    await worker.runOnce();
    const afterFailure = repo.findByEventId('evt-int-2');
    assert.ok(afterFailure);
    assert.equal(afterFailure.status, 'pending');
    assert.equal(afterFailure.attempts, 1);

    await worker.runOnce();
    const afterRetry = repo.findByEventId('evt-int-2');
    assert.ok(afterRetry);
    assert.equal(afterRetry.status, 'completed');
    assert.equal(mock.state.received, 1);
    assert.equal(mock.state.rejected, 1);
  } finally {
    repo.close();
    await server.close();
  }
});

test('the mock deduplicates on Idempotency-Key, closing the send-twice window', async () => {
  const mock = createMockNetsuite({ hmacSecret: SECRET });
  const server = await listen(mock.app);
  const repo = new OperaEventsRepo(':memory:', { maxAttempts: 3 });

  try {
    const client = createNetsuiteClient(
      createTestConfig({
        hmacSecret: SECRET,
        netsuiteUrl: `${server.url}/api/v1/opera/events`,
      }),
    );
    const worker = makeWorker(repo, client);
    const payload = Buffer.from('{"eventId":"evt-int-3"}', 'utf8');

    repo.enqueue('evt-int-3', payload);
    await worker.runOnce();

    // Simulate the crash window: the same event is sent again before the local
    // status flip could be persisted. The receiver must absorb it.
    const replay = await client.send('evt-int-3', payload);

    assert.equal(replay.ok, true);
    assert.equal(replay.status, 200);
    assert.equal(mock.state.received, 1);
    assert.equal(mock.state.duplicate, 1);
  } finally {
    repo.close();
    await server.close();
  }
});
