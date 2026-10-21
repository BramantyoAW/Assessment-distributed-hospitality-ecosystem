import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { postWebhook, startHarness } from './helpers.js';

test('a new event is stored and acknowledged with 202 accepted', async () => {
  const harness = await startHarness();
  try {
    const response = await postWebhook(harness.url, JSON.stringify({ eventId: 'evt-new', amount: 100 }));

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { status: 'accepted', eventId: 'evt-new' });
    assert.equal(harness.repo.countByStatus('pending'), 1);
  } finally {
    await harness.close();
  }
});

test('the same event twice is 202 duplicate both times and stored once', async () => {
  const harness = await startHarness();
  try {
    const raw = JSON.stringify({ eventId: 'evt-dup', amount: 100 });

    const first = await postWebhook(harness.url, raw);
    const second = await postWebhook(harness.url, raw);

    // Both are 202: the assessment fixes the contract at "202 immediately", and
    // a duplicate was accepted on its first delivery.
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);

    assert.deepEqual(await first.json(), { status: 'accepted', eventId: 'evt-dup' });
    assert.deepEqual(await second.json(), { status: 'duplicate', eventId: 'evt-dup' });

    assert.equal(harness.repo.countByStatus('pending'), 1);
  } finally {
    await harness.close();
  }
});

test('raw request bytes survive the round trip unchanged', async () => {
  const harness = await startHarness();
  try {
    // Deliberately ugly: extra spaces, unusual key order, a JSON escape and a
    // trailing-value formatting that JSON.stringify would normalise away.
    const raw = '{\n  "eventId"  :  "evt-raw",\n  "note" : "caf\\u00e9",\n  "amount" : 1.50\n}';

    const response = await postWebhook(harness.url, raw);
    assert.equal(response.status, 202);

    const stored = harness.repo.findByEventId('evt-raw');
    assert.ok(stored, 'event must be persisted');
    assert.ok(
      stored.payload.equals(Buffer.from(raw, 'utf8')),
      'stored payload must be byte-identical to the request body',
    );

    // Proof that a re-serialisation approach would have broken the signature.
    assert.notEqual(JSON.stringify(JSON.parse(raw)), raw);
  } finally {
    await harness.close();
  }
});

test('a non-JSON content type is rejected with 415', async () => {
  const harness = await startHarness();
  try {
    const response = await fetch(`${harness.url}/webhook/opera`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        authorization: `Bearer ${harness.config.bearerToken}`,
      },
      body: JSON.stringify({ eventId: 'evt-text' }),
    });

    assert.equal(response.status, 415);
    assert.equal(harness.repo.countByStatus('pending'), 0);
  } finally {
    await harness.close();
  }
});

test('malformed JSON is rejected with 400', async () => {
  const harness = await startHarness();
  try {
    const response = await postWebhook(harness.url, '{"eventId": ');

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_json' });
  } finally {
    await harness.close();
  }
});

test('eventId may arrive through the X-Event-Id header', async () => {
  const harness = await startHarness();
  try {
    const response = await postWebhook(harness.url, JSON.stringify({ amount: 100 }), {
      'x-event-id': 'evt-from-header',
    });

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { status: 'accepted', eventId: 'evt-from-header' });
    assert.ok(harness.repo.findByEventId('evt-from-header'));
  } finally {
    await harness.close();
  }
});

test('an eventId with unsafe characters is rejected with 400', async () => {
  const harness = await startHarness();
  try {
    const response = await postWebhook(harness.url, JSON.stringify({ eventId: 'bad id\nwith newline' }));

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_event_id' });
    assert.equal(harness.repo.countByStatus('pending'), 0);
  } finally {
    await harness.close();
  }
});

test('health endpoint stays public and does not require a token', async () => {
  const harness = await startHarness();
  try {
    const response = await fetch(`${harness.url}/healthz`);
    assert.equal(response.status, 200);
  } finally {
    await harness.close();
  }
});
