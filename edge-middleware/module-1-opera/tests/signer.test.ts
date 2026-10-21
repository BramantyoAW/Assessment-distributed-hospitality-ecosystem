import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  buildCanonicalString,
  currentTimestampSeconds,
  isTimestampFresh,
  sha256Hex,
  signCanonical,
  signRequest,
  verifySignature,
} from '../src/netsuite/signer.js';

/**
 * Fixed vector. These literals were produced once with node:crypto and are
 * hardcoded here so the test fails if the canonical string format ever drifts.
 * Computing the expectation with the same function under test would prove
 * nothing.
 */
const BODY = Buffer.from('{"eventId":"evt-1","amount":100}', 'utf8');
const SECRET = 'test-secret';

const EXPECTED_BODY_SHA256 = 'd7d229c239e3a9f7d2098bff49b50ec7dfe33a2fbcdda4d7f7e2b37e75312e1f';
const EXPECTED_CANONICAL =
  'POST\n/api/v1/opera/events\n1735689600\n' + EXPECTED_BODY_SHA256;
const EXPECTED_SIGNATURE =
  'v1=3ad7cd7778963d2d170884868b13c7665479431ba5b530c19fe8a9001456f4f7';

test('sha256Hex matches the fixed vector', () => {
  assert.equal(sha256Hex(BODY), EXPECTED_BODY_SHA256);
});

test('canonical string is METHOD \\n PATH \\n TIMESTAMP \\n SHA256(BODY)', () => {
  const canonical = buildCanonicalString({
    method: 'post',
    path: '/api/v1/opera/events',
    timestamp: '1735689600',
    body: BODY,
  });

  assert.equal(canonical, EXPECTED_CANONICAL);
  assert.equal(canonical.split('\n').length, 4);
});

test('signature matches the fixed vector and is version prefixed', () => {
  const signature = signRequest(
    { method: 'POST', path: '/api/v1/opera/events', timestamp: '1735689600', body: BODY },
    SECRET,
  );

  assert.equal(signature, EXPECTED_SIGNATURE);
  assert.ok(signature.startsWith('v1='));
});

test('verification accepts the matching signature and rejects others', () => {
  assert.equal(verifySignature(EXPECTED_SIGNATURE, EXPECTED_CANONICAL, SECRET), true);
  assert.equal(verifySignature(EXPECTED_SIGNATURE, EXPECTED_CANONICAL, 'other-secret'), false);
  assert.equal(verifySignature('v1=deadbeef', EXPECTED_CANONICAL, SECRET), false);
  assert.equal(verifySignature(undefined, EXPECTED_CANONICAL, SECRET), false);
});

test('any change to the payload invalidates the signature', () => {
  const tampered = Buffer.from('{"eventId":"evt-1","amount":101}', 'utf8');
  const tamperedSignature = signRequest(
    { method: 'POST', path: '/api/v1/opera/events', timestamp: '1735689600', body: tampered },
    SECRET,
  );

  assert.notEqual(tamperedSignature, EXPECTED_SIGNATURE);
  assert.equal(verifySignature(tamperedSignature, EXPECTED_CANONICAL, SECRET), false);
});

test('signature depends on the timestamp, so a replay is detectable', () => {
  const laterTimestamp = '1735689900';
  const laterSignature = signCanonical(
    buildCanonicalString({
      method: 'POST',
      path: '/api/v1/opera/events',
      timestamp: laterTimestamp,
      body: BODY,
    }),
    SECRET,
  );

  assert.notEqual(laterSignature, EXPECTED_SIGNATURE);
});

test('timestamp freshness enforces a clock skew window', () => {
  const now = 1_735_689_600;

  assert.equal(isTimestampFresh(String(now), now, 300), true);
  assert.equal(isTimestampFresh(String(now - 299), now, 300), true);
  assert.equal(isTimestampFresh(String(now - 301), now, 300), false);
  assert.equal(isTimestampFresh(String(now + 5000), now, 300), false);
  assert.equal(isTimestampFresh('not-a-number', now, 300), false);
});

test('currentTimestampSeconds returns integer seconds', () => {
  const value = currentTimestampSeconds();
  assert.match(value, /^\d+$/);
});
