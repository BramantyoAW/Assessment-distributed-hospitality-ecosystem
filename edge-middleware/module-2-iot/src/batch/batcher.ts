import { randomUUID } from 'node:crypto';

import type { BigQueryAdapter, IotRow } from '../bigquery/adapter.js';
import { toBusinessDate } from '../lib/business-date.js';
import type { Logger } from '../logger.js';
import type { IotEvent, IotEventsRepo } from '../store/events.repo.js';

/**
 * Micro-batcher: collects rows locally and writes them to the warehouse in one
 * call per interval, instead of one call per camera reading.
 *
 * Three triggers, because each covers a failure mode the others do not:
 *   1. timer       - a low-volume location must not wait for a full batch
 *   2. size        - a busy location must not wait for the timer
 *   3. shutdown    - a restart must not discard a pending batch
 */

export interface BatcherDeps {
  readonly repo: IotEventsRepo;
  readonly adapter: BigQueryAdapter;
  readonly logger: Logger;
  readonly intervalMs: number;
  readonly maxBatchSize: number;
  readonly maxAttempts: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly shutdownFlushMs: number;
  readonly now?: () => number;
  readonly random?: () => number;
}

export interface FlushResult {
  readonly sent: number;
  readonly deadLettered: number;
}

export interface Batcher {
  start(): void;
  /** Called after an ingest; flushes right away if the size trigger is met. */
  maybeFlush(): void;
  flush(): Promise<FlushResult>;
  /** Stops the timer and drains once. Never leaves rows claimed. */
  stop(): Promise<void>;
}

export function computeRetryDelayMs(
  attempts: number,
  baseMs: number,
  maxMs: number,
  jitter: number,
): number {
  if (baseMs <= 0) return 0;
  const exponential = baseMs * 2 ** Math.max(0, attempts - 1);
  return Math.min(exponential, maxMs) + Math.floor(jitter * 250);
}

export function createBatcher(deps: BatcherDeps): Batcher {
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;

  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<FlushResult> | undefined;
  let stopping = false;

  const run = async (): Promise<FlushResult> => {
    const batchId = randomUUID();
    const rows = deps.repo.claimBatch(batchId, deps.maxBatchSize, new Date(now()));
    if (rows.length === 0) return { sent: 0, deadLettered: 0 };

    try {
      await deps.adapter.insertBatch(rows.map(toRow));
      deps.repo.markSent(batchId);
      deps.logger.info('iot_batch_sent', {
        batchId,
        count: rows.length,
        firstEventId: rows[0]?.eventId ?? null,
      });
      return { sent: rows.length, deadLettered: 0 };
    } catch (error) {
      const reason = describe(error);
      // The batch is ordered by id, so the highest attempt count is the oldest
      // retry in it; base the next delay on that rather than on a single row.
      const attempts = rows.reduce((max, row) => Math.max(max, row.attempts), 0) + 1;
      const delayMs = computeRetryDelayMs(attempts, deps.retryBaseMs, deps.retryMaxMs, random());
      const nextAttemptAt = new Date(now() + delayMs).toISOString();

      deps.repo.markBatchFailed(batchId, nextAttemptAt, reason);

      const deadLettered = rows.filter((row) => row.attempts + 1 >= deps.maxAttempts).length;
      deps.logger.error('iot_batch_failed', {
        batchId,
        count: rows.length,
        attempts,
        deadLettered,
        retryInMs: delayMs,
        reason,
      });

      return { sent: 0, deadLettered };
    }
  };

  const flush = (): Promise<FlushResult> => {
    // Single flight: a timer tick and a size trigger must not claim two batches
    // that then race to mark each other's rows.
    if (inFlight !== undefined) return inFlight;
    const started = run().finally(() => {
      inFlight = undefined;
    });
    inFlight = started;
    return started;
  };

  const schedule = (delayMs: number): void => {
    if (stopping) return;
    timer = setTimeout(() => {
      void tick();
    }, delayMs);
    timer.unref();
  };

  const tick = async (): Promise<void> => {
    if (stopping) return;
    try {
      await flush();
    } catch (error) {
      deps.logger.error('iot_flush_failed', { message: describe(error) });
    }
    schedule(deps.intervalMs);
  };

  const maybeFlush = (): void => {
    if (stopping) return;
    if (deps.repo.countDue(new Date(now())) < deps.maxBatchSize) return;
    void flush().catch((error: unknown) => {
      deps.logger.error('iot_flush_failed', { message: describe(error) });
    });
  };

  const stop = async (): Promise<void> => {
    stopping = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }

    if (inFlight !== undefined) {
      await Promise.race([inFlight, delay(deps.shutdownFlushMs)]);
    }

    // Final drain so a restart does not wait a full interval for rows that are
    // already buffered and due.
    try {
      await Promise.race([flush(), delay(deps.shutdownFlushMs)]);
    } catch (error) {
      deps.logger.error('iot_flush_failed', { message: describe(error) });
    }
  };

  return {
    start(): void {
      if (stopping || timer !== undefined) return;
      schedule(deps.intervalMs);
    },
    maybeFlush,
    flush,
    stop,
  };
}

function toRow(event: IotEvent): IotRow {
  if (event.intervalSeconds === null) {
    // `claimBatch` filters these out, so this is an invariant, not a case. If it
    // ever fires the batch fails loudly and the row dead-letters with a reason,
    // instead of shipping a NULL that BigQuery would reject on load.
    throw new Error(`invariant violated: event ${event.eventId} has no interval_seconds`);
  }

  return {
    eventId: event.eventId,
    locationId: event.locationId,
    businessDate: toBusinessDate(event.observedAt),
    cameraId: event.cameraId,
    peopleCount: event.peopleCount,
    intervalSeconds: event.intervalSeconds,
    observedAt: event.observedAt,
    receivedAt: event.receivedAt,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
