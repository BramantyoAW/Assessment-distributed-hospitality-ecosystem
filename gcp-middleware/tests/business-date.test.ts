import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  toBusinessDate,
  toDayBucketStart,
  toHourBucketStart,
} from '../src/lib/business-date.js';

test('a 00:30 WITA reading belongs to that day, not the previous UTC day', () => {
  // 16:30Z on 30 April is 00:30 WITA on 1 May.
  assert.equal(toBusinessDate('2026-04-30T16:30:00.000Z'), '2026-05-01');
  assert.equal(toBusinessDate('2026-04-30T15:59:59.000Z'), '2026-04-30');
});

test('the naive UTC derivation would be wrong here, which is why this exists', () => {
  const instant = '2026-04-30T16:30:00.000Z';
  assert.equal(instant.slice(0, 10), '2026-04-30');
  assert.equal(toBusinessDate(instant), '2026-05-01');
});

test('hour and day buckets are anchored in the venue timezone', () => {
  assert.equal(toHourBucketStart('2026-05-01T17:45:00.000Z'), '2026-05-02T01:00:00+08:00');
  assert.equal(toDayBucketStart('2026-05-01T17:45:00.000Z'), '2026-05-02T00:00:00+08:00');
});

test('midnight renders as 00, never as 24', () => {
  assert.equal(toHourBucketStart('2026-04-30T16:00:00.000Z'), '2026-05-01T00:00:00+08:00');
});

test('an unparseable timestamp throws instead of producing a wrong date', () => {
  assert.throws(() => toBusinessDate('not-a-date'), RangeError);
});
