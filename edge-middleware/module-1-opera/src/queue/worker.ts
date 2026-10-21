import type { Logger } from '../logger.js';
import type { NetsuiteClient, SendOutcome } from '../netsuite/client.js';
import type { OperaEvent, OperaEventsRepo } from './events.repo.js';

/**
 * Background worker that drains the Opera queue.
 *
 * Runs as one sequential loop inside the HTTP process. SQLite has a single
 * writer, and sequential processing keeps ordering by `id` plus deterministic
 * tests. Volume from Opera PMS does not justify parallelism; if it ever does,
 * a bounded concurrency can be added without touching the schema.
 */

export interface OperaWorkerDeps {
  readonly repo: OperaEventsRepo;
  readonly client: NetsuiteClient;
  readonly logger: Logger;
  readonly pollIntervalMs: number;
  readonly retryBaseMs: number;
  readonly retryMaxDelayMs: number;
  readonly shutdownGraceMs: number;
  readonly batchSize?: number;
  readonly now?: () => number;
  readonly random?: () => number;
}

export interface OperaWorker {
  start(): void;
  stop(): Promise<void>;
  /** Process one batch synchronously. Used by tests and by `start` internally. */
  runOnce(): Promise<number>;
}

/**
 * Exponential backoff with additive jitter, so a set of events that fail
 * together do not stampede NetSuite on the same second.
 */
export function computeBackoffMs(
  attempts: number,
  baseMs: number,
  maxMs: number,
  jitter: number,
): number {
  if (baseMs <= 0) return 0;
  const exponential = baseMs * 2 ** Math.max(0, attempts - 1);
  return Math.min(exponential, maxMs) + Math.floor(jitter * 250);
}

export function createOperaWorker(deps: OperaWorkerDeps): OperaWorker {
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const batchSize = deps.batchSize ?? 10;

  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let stopping = false;

  const processOne = async (event: OperaEvent): Promise<void> => {
    let outcome: SendOutcome;

    try {
      outcome = await deps.client.send(event.eventId, event.payload);
    } catch (error) {
      outcome = {
        ok: false,
        status: 0,
        retryable: true,
        error: `unexpected: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (outcome.ok) {
      deps.repo.markCompleted(event.id, new Date(now()));
      deps.logger.info('netsuite_delivered', {
        eventId: event.eventId,
        attempts: event.attempts,
        status: outcome.status,
      });
      return;
    }

    const attempts = event.attempts + 1;
    const reason = outcome.error ?? `HTTP ${outcome.status}`;
    const exhausted = attempts >= event.maxAttempts;

    if (!outcome.retryable || exhausted) {
      deps.repo.markFailed(event.id, attempts, `${reason} (attempt ${attempts}/${event.maxAttempts})`);
      deps.logger.error('netsuite_rejected', {
        eventId: event.eventId,
        attempts,
        retryable: outcome.retryable,
        reason,
      });
      return;
    }

    const delayMs = computeBackoffMs(attempts, deps.retryBaseMs, deps.retryMaxDelayMs, random());
    const nextAttemptAt = new Date(now() + delayMs).toISOString();
    deps.repo.scheduleRetry(event.id, attempts, nextAttemptAt, reason);
    deps.logger.warn('netsuite_retry_scheduled', {
      eventId: event.eventId,
      attempts,
      delayMs,
      nextAttemptAt,
      reason,
    });
  };

  const runOnce = async (): Promise<number> => {
    const due = deps.repo.claimDue(new Date(now()), batchSize);
    if (due.length === 0) return 0;

    let processed = 0;
    for (const event of due) {
      if (stopping) {
        // Give the row back immediately instead of waiting for reclaimStale().
        deps.repo.releaseToPending(event.id);
        continue;
      }
      await processOne(event);
      processed += 1;
    }
    return processed;
  };

  const schedule = (delayMs: number): void => {
    if (stopping) return;
    timer = setTimeout(() => {
      void tick();
    }, delayMs);
    // Do not hold the event loop open just to poll.
    timer.unref();
  };

  const tick = async (): Promise<void> => {
    if (stopping) return;

    inFlight = runOnce()
      .then((processed) => {
        inFlight = undefined;
        // Drain immediately while there is more work, otherwise idle-poll.
        schedule(processed > 0 ? 0 : deps.pollIntervalMs);
      })
      .catch((error: unknown) => {
        inFlight = undefined;
        deps.logger.error('worker_cycle_failed', {
          message: error instanceof Error ? error.message : String(error),
        });
        schedule(deps.pollIntervalMs);
      });

    await inFlight;
  };

  return {
    start(): void {
      if (stopping || timer !== undefined || inFlight !== undefined) return;
      schedule(0);
    },

    async stop(): Promise<void> {
      stopping = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (inFlight === undefined) return;

      await Promise.race([inFlight, delay(deps.shutdownGraceMs)]);
    },

    runOnce,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
