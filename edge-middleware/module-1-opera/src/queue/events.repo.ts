import { DatabaseSync } from 'node:sqlite';

/**
 * Durable queue for incoming Opera events.
 *
 * One table holds both "event" and "job": they are strictly 1:1, so splitting
 * them would only add a join. State transitions live in the database, not in
 * memory, so a crash cannot lose a scheduled retry.
 */

export type OperaEventStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface OperaEvent {
  readonly id: number;
  readonly eventId: string;
  /** The exact bytes received on the wire. Used verbatim for HMAC and re-send. */
  readonly payload: Buffer;
  readonly status: OperaEventStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly nextAttemptAt: string;
  readonly lastError: string | null;
}

/** `accepted` = new row. `duplicate` = eventId already known, nothing written. */
export type EnqueueOutcome = 'accepted' | 'duplicate';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS opera_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        TEXT    NOT NULL UNIQUE,
  payload         BLOB    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','completed','failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 5,
  next_attempt_at TEXT    NOT NULL,
  claimed_at      TEXT,
  completed_at    TEXT,
  last_error      TEXT,
  received_at     TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_opera_due
  ON opera_events (status, next_attempt_at, id);
`;

const SELECT_COLUMNS = `
  id, event_id, payload, status, attempts, max_attempts, next_attempt_at, last_error
`;

export interface OperaEventsRepoOptions {
  readonly maxAttempts: number;
}

export class OperaEventsRepo {
  readonly #db: DatabaseSync;
  readonly #maxAttempts: number;

  constructor(dbPath: string, options: OperaEventsRepoOptions) {
    this.#db = new DatabaseSync(dbPath);
    this.#maxAttempts = options.maxAttempts;

    // WAL lets the HTTP path read while the worker writes.
    this.#db.exec('PRAGMA journal_mode = WAL;');
    this.#db.exec('PRAGMA busy_timeout = 5000;');
    this.#db.exec('PRAGMA foreign_keys = ON;');
    this.#db.exec(SCHEMA);
  }

  /**
   * Insert-if-absent in a single statement. Returns `duplicate` when the unique
   * index rejects the row, so there is no SELECT-then-INSERT race.
   */
  enqueue(eventId: string, payload: Buffer, now: Date = new Date()): EnqueueOutcome {
    const nowIso = now.toISOString();
    const result = this.#db
      .prepare(
        `INSERT INTO opera_events
           (event_id, payload, max_attempts, next_attempt_at, received_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(event_id) DO NOTHING`,
      )
      .run(eventId, payload, this.#maxAttempts, nowIso, nowIso);

    return Number(result.changes) === 0 ? 'duplicate' : 'accepted';
  }

  /**
   * Atomically select due rows and mark them `processing`.
   * Rows already claimed by someone else are skipped rather than thrown on.
   */
  claimDue(now: Date = new Date(), limit = 10): OperaEvent[] {
    const nowIso = now.toISOString();
    const claimed: OperaEvent[] = [];

    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.#db
        .prepare(
          `SELECT ${SELECT_COLUMNS}
             FROM opera_events
            WHERE status = 'pending' AND next_attempt_at <= ?
            ORDER BY id ASC
            LIMIT ?`,
        )
        .all(nowIso, limit);

      const claim = this.#db.prepare(
        `UPDATE opera_events
            SET status = 'processing', claimed_at = ?
          WHERE id = ? AND status = 'pending'`,
      );

      for (const row of rows) {
        const id = asNumber(row['id']);
        if (Number(claim.run(nowIso, id).changes) !== 1) continue;
        claimed.push({ ...mapEvent(row), status: 'processing' });
      }

      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }

    return claimed;
  }

  markCompleted(id: number, now: Date = new Date()): void {
    this.#db
      .prepare(
        `UPDATE opera_events
            SET status = 'completed', completed_at = ?, claimed_at = NULL, last_error = NULL
          WHERE id = ?`,
      )
      .run(now.toISOString(), id);
  }

  markFailed(id: number, attempts: number, error: string): void {
    this.#db
      .prepare(
        `UPDATE opera_events
            SET status = 'failed', attempts = ?, claimed_at = NULL, last_error = ?
          WHERE id = ?`,
      )
      .run(attempts, error, id);
  }

  scheduleRetry(id: number, attempts: number, nextAttemptAt: string, error: string): void {
    this.#db
      .prepare(
        `UPDATE opera_events
            SET status = 'pending', attempts = ?, next_attempt_at = ?,
                claimed_at = NULL, last_error = ?
          WHERE id = ?`,
      )
      .run(attempts, nextAttemptAt, error, id);
  }

  /** Put a claimed row back without touching its schedule (graceful shutdown). */
  releaseToPending(id: number): void {
    this.#db
      .prepare(`UPDATE opera_events SET status = 'pending', claimed_at = NULL WHERE id = ?`)
      .run(id);
  }

  /**
   * Recover rows left in `processing` by a previous run.
   * Safe because a single process owns this database file.
   */
  reclaimStale(): number {
    const result = this.#db
      .prepare(`UPDATE opera_events SET status = 'pending', claimed_at = NULL WHERE status = 'processing'`)
      .run();
    return Number(result.changes);
  }

  findByEventId(eventId: string): OperaEvent | null {
    const row = this.#db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM opera_events WHERE event_id = ?`)
      .get(eventId);
    return row === undefined ? null : mapEvent(row);
  }

  countByStatus(status: OperaEventStatus): number {
    const row = this.#db
      .prepare(`SELECT COUNT(*) AS total FROM opera_events WHERE status = ?`)
      .get(status);
    return asNumber(row?.['total']);
  }

  close(): void {
    this.#db.close();
  }
}

function mapEvent(row: Record<string, unknown>): OperaEvent {
  return {
    id: asNumber(row['id']),
    eventId: asString(row['event_id']),
    payload: asBlob(row['payload']),
    status: asStatus(row['status']),
    attempts: asNumber(row['attempts']),
    maxAttempts: asNumber(row['max_attempts']),
    nextAttemptAt: asString(row['next_attempt_at']),
    lastError: asNullableString(row['last_error']),
  };
}

// node:sqlite returns rows with a null prototype and widened value types, so
// every column is narrowed explicitly instead of being cast wholesale.
function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new TypeError(`expected a numeric column, received ${typeof value}`);
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  throw new TypeError(`expected a text column, received ${typeof value}`);
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asBlob(value: unknown): Buffer {
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new TypeError(`expected a BLOB column, received ${typeof value}`);
}

function asStatus(value: unknown): OperaEventStatus {
  if (value === 'pending' || value === 'processing' || value === 'completed' || value === 'failed') {
    return value;
  }
  throw new TypeError(`unexpected status value: ${String(value)}`);
}
