import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { parsePeopleCountPayload } from '../src/http/ingest.route.js';
import { postIngest, startHarness, validPayload } from './helpers.js';

test('a valid reading is persisted as pending and acknowledged with 202', async () => {
  const harness = await startHarness();
  try {
    const response = await postIngest(harness.url, validPayload());

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { status: 'accepted', eventId: 'evt-1' });

    const stored = harness.repo.findByEventId('evt-1');
    assert.ok(stored);
    assert.equal(stored.status, 'pending');
    assert.equal(stored.peopleCount, 42);
    assert.equal(stored.locationId, 'loc-lobby');
    assert.equal(stored.cameraId, 'cam-lobby-01');

    // The whole point of the buffer: no warehouse call on the request path.
    assert.equal(harness.adapter.batches.length, 0);
  } finally {
    await harness.close();
  }
});

test('the same eventId twice is 202 duplicate and stored once', async () => {
  const harness = await startHarness();
  try {
    const first = await postIngest(harness.url, validPayload());
    const second = await postIngest(harness.url, validPayload());

    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    assert.deepEqual(await first.json(), { status: 'accepted', eventId: 'evt-1' });
    assert.deepEqual(await second.json(), { status: 'duplicate', eventId: 'evt-1' });

    assert.equal(harness.repo.countByStatus('pending'), 1);
  } finally {
    await harness.close();
  }
});

test('peopleCount of zero is valid, not treated as missing', async () => {
  const harness = await startHarness();
  try {
    const response = await postIngest(harness.url, validPayload({ peopleCount: 0 }));

    assert.equal(response.status, 202);
    const stored = harness.repo.findByEventId('evt-1');
    assert.ok(stored);
    assert.equal(stored.peopleCount, 0);
  } finally {
    await harness.close();
  }
});

test('observedAt is normalised to UTC ISO 8601', async () => {
  const harness = await startHarness();
  try {
    const response = await postIngest(
      harness.url,
      validPayload({ observedAt: '2026-05-01T17:00:00+07:00' }),
    );

    assert.equal(response.status, 202);
    const stored = harness.repo.findByEventId('evt-1');
    assert.ok(stored);
    assert.equal(stored.observedAt, '2026-05-01T10:00:00.000Z');
  } finally {
    await harness.close();
  }
});

test('cameraId is optional', async () => {
  const harness = await startHarness();
  try {
    const body = validPayload();
    delete body['cameraId'];

    const response = await postIngest(harness.url, body);

    assert.equal(response.status, 202);
    const stored = harness.repo.findByEventId('evt-1');
    assert.ok(stored);
    assert.equal(stored.cameraId, null);
  } finally {
    await harness.close();
  }
});

test('missing X-API-Key is 401', async () => {
  const harness = await startHarness();
  try {
    const response = await fetch(`${harness.url}/ingest/people-count`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validPayload()),
    });

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'unauthorized' });
    assert.equal(harness.repo.countByStatus('pending'), 0);
  } finally {
    await harness.close();
  }
});

test('an API key of a different length is 401, never 500', async () => {
  const harness = await startHarness();
  try {
    const response = await postIngest(harness.url, validPayload(), { 'x-api-key': 'short' });

    assert.equal(response.status, 401);
    assert.notEqual(response.status, 500);
  } finally {
    await harness.close();
  }
});

test('a wrong API key of the same length is 401', async () => {
  const harness = await startHarness();
  try {
    const response = await postIngest(harness.url, validPayload(), { 'x-api-key': 'test-api-kex' });

    assert.equal(response.status, 401);
  } finally {
    await harness.close();
  }
});

test('a non-JSON content type is 415', async () => {
  const harness = await startHarness();
  try {
    const response = await fetch(`${harness.url}/ingest/people-count`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-api-key': harness.config.apiKey },
      body: JSON.stringify(validPayload()),
    });

    assert.equal(response.status, 415);
    assert.equal(harness.repo.countByStatus('pending'), 0);
  } finally {
    await harness.close();
  }
});

test('malformed JSON is 400', async () => {
  const harness = await startHarness();
  try {
    const response = await postIngest(harness.url, '{"eventId": ');

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_json' });
  } finally {
    await harness.close();
  }
});

test('invalid payload is rejected with the offending fields named', async () => {
  const harness = await startHarness();
  try {
    const response = await postIngest(
      harness.url,
      validPayload({ peopleCount: -1, observedAt: 'not-a-date' }),
    );

    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string; fields: string[] };
    assert.equal(body.error, 'invalid_payload');
    assert.equal(body.fields.length, 2);
    assert.ok(body.fields.some((field) => field.includes('peopleCount')));
    assert.ok(body.fields.some((field) => field.includes('observedAt')));
    assert.equal(harness.repo.countByStatus('pending'), 0);
  } finally {
    await harness.close();
  }
});

test('parser rejects a non-integer peopleCount and an unsafe eventId', () => {
  assert.equal(parsePeopleCountPayload(validPayload({ peopleCount: 4.5 })).ok, false);
  assert.equal(parsePeopleCountPayload(validPayload({ peopleCount: '42' })).ok, false);
  assert.equal(parsePeopleCountPayload(validPayload({ eventId: 'has space' })).ok, false);
  assert.equal(parsePeopleCountPayload(validPayload({ eventId: '' })).ok, false);
  assert.equal(parsePeopleCountPayload(null).ok, false);
  assert.equal(parsePeopleCountPayload(validPayload()).ok, true);
});

test('health endpoint stays public', async () => {
  const harness = await startHarness();
  try {
    const response = await fetch(`${harness.url}/healthz`);
    assert.equal(response.status, 200);
  } finally {
    await harness.close();
  }
});
