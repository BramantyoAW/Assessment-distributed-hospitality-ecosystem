import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { toBusinessDate } from '../src/lib/business-date.js';
import { IotEventsRepo, SCHEMA_VERSION } from '../src/store/events.repo.js';
import { makeTempDir } from './helpers.js';
import { join } from 'node:path';

import { postIngest, postIngestLegacy, startHarness, validPayload } from './helpers.js';

test("the brief's payload (no intervalSeconds) is still accepted, with the default assumed", async () => {
  const harness = await startHarness();
  try {
    const payload = validPayload();
    delete payload['intervalSeconds'];

    const response = await postIngest(harness.url, payload);

    assert.equal(response.status, 202, 'rejecting the documented payload would break Module 2');
    const stored = harness.repo.findByEventId('evt-1');
    assert.equal(stored?.intervalSeconds, 60, 'the configured default, not a hard-coded guess in code');
  } finally {
    await harness.close();
  }
});

test('the assumed interval comes from configuration', async () => {
  const harness = await startHarness({ defaultIntervalSeconds: 15 });
  try {
    const payload = validPayload();
    delete payload['intervalSeconds'];

    await postIngest(harness.url, payload);

    assert.equal(harness.repo.findByEventId('evt-1')?.intervalSeconds, 15);
  } finally {
    await harness.close();
  }
});

test('an explicit intervalSeconds outside [1, 3600] is rejected, including a non-integer', async () => {
  const harness = await startHarness();
  try {
    for (const bad of [0, -1, 3_601, 4.5, '30']) {
      const response = await postIngest(harness.url, validPayload({ intervalSeconds: bad }));
      assert.equal(response.status, 400, `intervalSeconds=${String(bad)} must be rejected`);
    }
  } finally {
    await harness.close();
  }
});

test('a valid intervalSeconds is persisted, not dropped between request and row', async () => {
  const harness = await startHarness();
  try {
    const response = await postIngest(harness.url, validPayload({ intervalSeconds: 45 }));

    assert.equal(response.status, 202);
    const stored = harness.repo.findByEventId('evt-1');
    assert.equal(stored?.intervalSeconds, 45);
  } finally {
    await harness.close();
  }
});

test('the Day 1 path still works as a compatibility alias', async () => {
  const harness = await startHarness();
  try {
    const response = await postIngestLegacy(harness.url, validPayload());

    assert.equal(response.status, 202);
    assert.equal(harness.repo.findByEventId('evt-1')?.intervalSeconds, 30);
  } finally {
    await harness.close();
  }
});

test('business_date uses Asia/Makassar, so a 00:30 WITA reading is not yesterday', () => {
  // 16:30Z on 30 April is 00:30 WITA on 1 May.
  assert.equal(toBusinessDate('2026-04-30T16:30:00.000Z'), '2026-05-01');
  assert.equal(toBusinessDate('2026-04-30T15:59:59.000Z'), '2026-04-30');
  assert.throws(() => toBusinessDate('not-a-date'), RangeError);
});

test('a Day 1 database is migrated: column added, version bumped, rows quarantined', () => {
  const dbPath = join(makeTempDir(), 'legacy.db');

  // The exact Day 1 schema, without interval_seconds.
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE iot_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id        TEXT    NOT NULL UNIQUE,
      location_id     TEXT    NOT NULL,
      camera_id       TEXT,
      people_count    INTEGER NOT NULL,
      observed_at     TEXT    NOT NULL,
      received_at     TEXT    NOT NULL,
      status          TEXT    NOT NULL DEFAULT 'pending',
      batch_id        TEXT,
      attempts        INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT    NOT NULL,
      last_error      TEXT
    );
  `);
  legacy
    .prepare(
      `INSERT INTO iot_events
         (event_id, location_id, camera_id, people_count, observed_at, received_at, next_attempt_at)
       VALUES ('old-1', 'loc-lobby', 'cam-1', 5, '2026-05-01T10:00:00.000Z',
               '2026-05-01T10:00:01.000Z', '2026-05-01T10:00:01.000Z')`,
    )
    .run();
  legacy.close();

  const repo = new IotEventsRepo(dbPath, { maxAttempts: 3 });
  try {
    assert.equal(repo.schemaVersion(), SCHEMA_VERSION);

    // Nullable, never defaulted: an invented interval would flow into
    // SUM(interval_seconds) as if it were measured.
    assert.equal(repo.findByEventId('old-1')?.intervalSeconds, null);

    const quarantined = repo.quarantineMissingInterval();
    assert.equal(quarantined, 1);

    const stored = repo.findByEventId('old-1');
    assert.equal(stored?.status, 'failed');
    assert.match(stored?.lastError ?? '', /interval_seconds/);

    // And it can never be shipped, even if the quarantine were skipped.
    assert.equal(repo.claimBatch('batch-1', 100).length, 0);
  } finally {
    repo.close();
  }
});

test('a claim skips rows without an interval even while they are still pending', () => {
  const dbPath = join(makeTempDir(), 'claim.db');

  // Only a migrated database can hold a NULL interval, which is exactly the
  // situation the claim filter exists for.
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE iot_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id        TEXT    NOT NULL UNIQUE,
      location_id     TEXT    NOT NULL,
      camera_id       TEXT,
      people_count    INTEGER NOT NULL,
      observed_at     TEXT    NOT NULL,
      received_at     TEXT    NOT NULL,
      status          TEXT    NOT NULL DEFAULT 'pending',
      batch_id        TEXT,
      attempts        INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT    NOT NULL,
      last_error      TEXT
    );
  `);
  legacy.close();

  const repo = new IotEventsRepo(dbPath, { maxAttempts: 3 });
  try {
    repo.ingest({
      eventId: 'evt-ok',
      locationId: 'loc-lobby',
      cameraId: null,
      peopleCount: 1,
      intervalSeconds: 30,
      observedAt: '2026-05-01T10:00:00.000Z',
    });

    // A pre-contract row that was not quarantined (e.g. inserted by an old build).
    const raw = new DatabaseSync(dbPath);
    raw
      .prepare(
        `INSERT INTO iot_events
           (event_id, location_id, people_count, interval_seconds, observed_at,
            received_at, next_attempt_at)
         VALUES ('evt-null', 'loc-lobby', 2, NULL, '2026-05-01T10:00:00.000Z',
                 '2026-05-01T10:00:00.000Z', '2026-05-01T10:00:00.000Z')`,
      )
      .run();
    raw.close();

    const claimed = repo.claimBatch('batch-1', 100);

    assert.deepEqual(
      claimed.map((row) => row.eventId),
      ['evt-ok'],
    );
  } finally {
    repo.close();
  }
});
