import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { safeEqual } from '../src/lib/safe-equal.js';
import { BEARER, postWebhook, startHarness } from './helpers.js';

test('missing Authorization header is rejected with 401', async () => {
  const harness = await startHarness();
  try {
    const response = await fetch(`${harness.url}/webhook/opera`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventId: 'evt-1' }),
    });

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'unauthorized' });
    assert.equal(harness.repo.countByStatus('pending'), 0);
  } finally {
    await harness.close();
  }
});

test('token of a different length is 401, never 500', async () => {
  // This is the regression guard for crypto.timingSafeEqual throwing on
  // mismatched buffer lengths. A 500 here would mean the length guard is gone.
  const harness = await startHarness();
  try {
    const response = await postWebhook(harness.url, JSON.stringify({ eventId: 'evt-1' }), {
      authorization: 'Bearer short',
    });

    assert.equal(response.status, 401);
    assert.notEqual(response.status, 500);
  } finally {
    await harness.close();
  }
});

test('token of the same length but wrong content is 401', async () => {
  const harness = await startHarness();
  try {
    const wrongSameLength = BEARER.replace(/.$/, (last) => (last === 'x' ? 'y' : 'x'));
    assert.equal(wrongSameLength.length, BEARER.length);

    const response = await postWebhook(harness.url, JSON.stringify({ eventId: 'evt-1' }), {
      authorization: `Bearer ${wrongSameLength}`,
    });

    assert.equal(response.status, 401);
  } finally {
    await harness.close();
  }
});

test('Authorization header without the Bearer scheme is 401', async () => {
  const harness = await startHarness();
  try {
    const response = await postWebhook(harness.url, JSON.stringify({ eventId: 'evt-1' }), {
      authorization: `Basic ${BEARER}`,
    });

    assert.equal(response.status, 401);
  } finally {
    await harness.close();
  }
});

test('valid token but missing eventId is 400', async () => {
  const harness = await startHarness();
  try {
    const response = await postWebhook(harness.url, JSON.stringify({ amount: 100 }));

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'missing_event_id' });
    assert.equal(harness.repo.countByStatus('pending'), 0);
  } finally {
    await harness.close();
  }
});

test('valid token and eventId is 202 Accepted', async () => {
  const harness = await startHarness();
  try {
    const response = await postWebhook(harness.url, JSON.stringify({ eventId: 'evt-auth-ok' }));

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { status: 'accepted', eventId: 'evt-auth-ok' });
    assert.equal(harness.repo.countByStatus('pending'), 1);
  } finally {
    await harness.close();
  }
});

test('safeEqual returns false for an empty expected value', () => {
  // An unset secret must never behave like "accept anything".
  assert.equal(safeEqual('anything', ''), false);
  assert.equal(safeEqual(undefined, 'expected'), false);
  assert.equal(safeEqual('expected', 'expected'), true);
});
