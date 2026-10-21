import { DatabaseSync } from 'node:sqlite';

/**
 * Durable buffer for people-count events coming from the cameras.
 *
 * The row IS the event and the row IS the batch membership: `batch_id` is a
 * column, not a table. A separate batches table would only be needed if batches
 * had their own lifecycle worth querying, and they do not.
 */

export type IotStatus = 'pending' | 'in_flight' | 'sent' | 'failed';

export interface NewIotEvent {
  readonly eventId: string;
  readonly locationId: string;
  readonly cameraId: string | null;
  readonly peopleCount: number;
  readonly intervalSeconds: number;
  readonly observedAt: string;
}

export interface IotEvent {
  readonly id: number;
  readonly eventId: string;
  readonly locationId: string;
  readonly cameraId: string | null;
  readonly peopleCount: number;
  /**
   * Null only for rows written before the interval became part of the contract.
   * Those rows are quarantined and never claimed, so `toRow` can treat a value
   * in a claimed batch as guaranteed.
   */
  readonly intervalSeconds: number | null;
  readonly observedAt: string;
  readonly receivedAt: string;
  readonly status: IotStatus;
  readonly batchId: string | null;
  readonly attempts: number;
  readonly nextAttemptAt: string;
  readonly lastError: string | null;
}

export type IngestOutcome = 'accepted' | 'duplicate';

/** Bumped whenever a migration adds a column; asserted by the migration test. */
export const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS iot_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        TEXT    NOT NULL UNIQUE,
  location_id     TEXT    NOT NULL,
  camera_id       TEXT,
  people_count    INTEGER NOT NULL CHECK (people_count >= 0),
  interval_seconds INTEGER NOT NULL CHECK (interval_seconds BETWEEN 1 AND 3600),
  observed_at     TEXT    NOT NULL,
  received_at     TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','in_flight','sent','failed')),
  batch_id        TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT    NOT NULL,
  last_error      TEXT
);

CREATE INDEX IF NOT EXISTS idx_iot_due
  ON iot_events (status, next_attempt_at, id);

CREATE INDEX IF NOT EXISTS idx_iot_batch
  ON iot_events (batch_id);
`;

const COLUMNS = `
  id, event_id, location_id, camera_id, people_count, interval_seconds,
  observed_at, received_at, status, batch_id, attempts, next_attempt_at, last_error
`;

const PRE_CONTRACT_ERROR = 'missing interval_seconds (pre-contract row)';

export interface IotEventsRepoOptions {
  readonly maxAttempts: number;
}

export class IotEventsRepo {
  readonly #db: DatabaseSync;
  readonly #maxAttempts: number;

  constructor(dbPath: string, options: IotEventsRepoOptions) {
    this.#db = new DatabaseSync(dbPath);
    this.#maxAttempts = options.maxAttempts;

    this.#db.exec('PRAGMA journal_mode = WAL;');
    this.#db.exec('PRAGMA busy_timeout = 5000;');
    this.#db.exec(SCHEMA);
    this.#migrate();
  }

  /**
   * A database created on Day 1 has no `interval_seconds` column.
   *
   * The column is added nullable and NOT backfilled: `DEFAULT 30` would invent a
   * measurement, and that invented value would flow straight into
   * `SUM(interval_seconds)` in the warehouse. Rows that genuinely predate the
   * contract are quarantined so they are visible in `last_error` instead of
   * being silently unshippable or silently fake.
   */
  #migrate(): void {
    const columns = this.#db.prepare('PRAGMA table_info(iot_events)').all();
    const hasInterval = columns.some((column) => column['name'] === 'interval_seconds');

    if (!hasInterval) {
      this.#db.exec('ALTER TABLE iot_events ADD COLUMN interval_seconds INTEGER');
    }

    this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  /**
   * Mark pre-contract rows as failed so they never reach a batch.
   *
   * Belt and braces: `claimBatch` also filters `interval_seconds IS NOT NULL`,
   * so even if this is never called the rows cannot be shipped. They would sit
   * in `pending` forever, though, which is why the caller logs the count.
   */
  quarantineMissingInterval(): number {
    const result = this.#db
      .prepare(
        `UPDATE iot_events
            SET status = 'failed', last_error = ?
          WHERE status = 'pending' AND interval_seconds IS NULL`,
      )
      .run(PRE_CONTRACT_ERROR);
    return Number(result.changes);
  }

  /**
   * `eventId` is supplied by the device, not derived by us. A derived hash would
   * silently collapse two real observations that happen to look identical, and
   * the conversion rate in the warehouse (transactions / visits) would then be
   * wrong in the optimistic direction.
   */
  ingest(event: NewIotEvent, now: Date = new Date()): IngestOutcome {
    const nowIso = now.toISOString();
    const result = this.#db
      .prepare(
        `INSERT INTO iot_events
           (event_id, location_id, camera_id, people_count, interval_seconds,
            observed_at, received_at, next_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_id) DO NOTHING`,
      )
      .run(
        event.eventId,
        event.locationId,
        event.cameraId,
        event.peopleCount,
        event.intervalSeconds,
        event.observedAt,
        nowIso,
        nowIso,
      );

    return Number(result.changes) === 0 ? 'duplicate' : 'accepted';
  }

  /**
   * Claim up to `limit` due rows into one batch.
   *
   * `in_flight` is a visible state, not a lock: if the process dies mid-flush the
   * rows stay in `in_flight` and are recovered by `reclaimInFlight()` on restart.
   */
  claimBatch(batchId: string, limit: number, now: Date = new Date()): IotEvent[] {
    const nowIso = now.toISOString();
    const claimed: IotEvent[] = [];

    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.#db
        .prepare(
          `SELECT ${COLUMNS}
             FROM iot_events
            WHERE status = 'pending'
              AND interval_seconds IS NOT NULL
              AND next_attempt_at <= ?
            ORDER BY id ASC
            LIMIT ?`,
        )
        .all(nowIso, limit);

      const claim = this.#db.prepare(
        `UPDATE iot_events
            SET status = 'in_flight', batch_id = ?
          WHERE id = ? AND status = 'pending'`,
      );

      for (const row of rows) {
        const id = asNumber(row['id']);
        if (Number(claim.run(batchId, id).changes) !== 1) continue;
        claimed.push({ ...mapEvent(row), status: 'in_flight', batchId });
      }

      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }

    return claimed;
  }

  markSent(batchId: string): number {
    const result = this.#db
      .prepare(`UPDATE iot_events SET status = 'sent', last_error = NULL WHERE batch_id = ?`)
      .run(batchId);
    return Number(result.changes);
  }

  /**
   * A failed batch never disappears. Rows go back to `pending` while attempts
   * remain, and become `failed` (dead letter) when they run out. Either way the
   * rows stay queryable, which is what "no silent data loss" has to mean.
   */
  markBatchFailed(batchId: string, nextAttemptAt: string, error: string): number {
    const result = this.#db
      .prepare(
        `UPDATE iot_events
            SET status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END,
                attempts = attempts + 1,
                next_attempt_at = ?,
                last_error = ?,
                batch_id = NULL
          WHERE batch_id = ?`,
      )
      .run(this.#maxAttempts, nextAttemptAt, error, batchId);
    return Number(result.changes);
  }

  /** Rows stranded in `in_flight` by a dead process. */
  reclaimInFlight(): number {
    const result = this.#db
      .prepare(
        `UPDATE iot_events
            SET status = 'pending', batch_id = NULL
          WHERE status = 'in_flight'`,
      )
      .run();
    return Number(result.changes);
  }

  countDue(now: Date = new Date()): number {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS total
           FROM iot_events
          WHERE status = 'pending'
            AND interval_seconds IS NOT NULL
            AND next_attempt_at <= ?`,
      )
      .get(now.toISOString());
    return asNumber(row?.['total']);
  }

  countByStatus(status: IotStatus): number {
    const row = this.#db
      .prepare(`SELECT COUNT(*) AS total FROM iot_events WHERE status = ?`)
      .get(status);
    return asNumber(row?.['total']);
  }

  findByEventId(eventId: string): IotEvent | null {
    const row = this.#db.prepare(`SELECT ${COLUMNS} FROM iot_events WHERE event_id = ?`).get(eventId);
    return row === undefined ? null : mapEvent(row);
  }

  listByStatus(status: IotStatus, limit = 100): IotEvent[] {
    return this.#db
      .prepare(`SELECT ${COLUMNS} FROM iot_events WHERE status = ? ORDER BY id ASC LIMIT ?`)
      .all(status, limit)
      .map(mapEvent);
  }

  schemaVersion(): number {
    const row = this.#db.prepare('PRAGMA user_version').get();
    return asNumber(row?.['user_version']);
  }

  close(): void {
    this.#db.close();
  }
}

function mapEvent(row: Record<string, unknown>): IotEvent {
  return {
    id: asNumber(row['id']),
    eventId: asString(row['event_id']),
    locationId: asString(row['location_id']),
    cameraId: asNullableString(row['camera_id']),
    peopleCount: asNumber(row['people_count']),
    intervalSeconds: asNullableNumber(row['interval_seconds']),
    observedAt: asString(row['observed_at']),
    receivedAt: asString(row['received_at']),
    status: asStatus(row['status']),
    batchId: asNullableString(row['batch_id']),
    attempts: asNumber(row['attempts']),
    nextAttemptAt: asString(row['next_attempt_at']),
    lastError: asNullableString(row['last_error']),
  };
}

function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new TypeError(`expected a numeric column, received ${typeof value}`);
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return asNumber(value);
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  throw new TypeError(`expected a text column, received ${typeof value}`);
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asStatus(value: unknown): IotStatus {
  if (value === 'pending' || value === 'in_flight' || value === 'sent' || value === 'failed') {
    return value;
  }
  throw new TypeError(`unexpected status value: ${String(value)}`);
}
