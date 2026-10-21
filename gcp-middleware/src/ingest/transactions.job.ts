/**
 * Transaction ingest: NetSuite SuiteQL -> BigQuery, one run per Cloud Run Job
 * execution.
 *
 * Incremental by checkpoint, not by `MAX(source_modified_at)` and not by OFFSET.
 *
 *  - A checkpoint records how far the *read* got, including the last raw row. That
 *    is a statement about the source. `MAX(source_modified_at)` over the warehouse
 *    is an inference from what was *written*: it skips a late correction whose
 *    modification date is older than the newest one already loaded, and it has no
 *    answer at all when a run dies mid-page.
 *  - Every run re-reads `lookbackMinutes` before the cursor. The overlap costs one
 *    repeated page and removes the whole class of "record modified at 23:59:59
 *    while the pull was running" gaps. Duplicates are absorbed by
 *    `vw_fact_transactions`, so the overlap is free by construction.
 *
 * The job never writes via DML: `WRITE_APPEND` load jobs only, because the target
 * environment is the BigQuery Sandbox.
 */

import type {
  BigQueryGateway,
  CheckpointRecord,
  TransactionFact,
} from '../bigquery/gateway.js';
import type { Logger } from '../logger.js';
import type { NetSuiteClient, SuiteQlRow } from '../netsuite/client.js';
import { mapTransactionRow } from '../netsuite/mapping.js';
import type { MappingResult, RejectionReason } from '../netsuite/mapping.js';

export const STREAM = 'transactions';

export interface StartPlanInput {
  readonly checkpoint: CheckpointRecord | null;
  readonly lookbackMinutes: number;
  /** First-run floor: nothing older than this is backfilled. */
  readonly bootstrapSince: string;
  readonly now: Date;
}

/**
 * Where this run starts reading.
 *
 * On the first run the cursor comes from `NETSUITE_BOOTSTRAP_SINCE`, which is a
 * deliberate decision rather than "all history": a full history scan on a cold
 * start is unbounded, and a backfill should be a separate run with a known range.
 */
export function planStart(input: StartPlanInput): { sinceIso: string } {
  if (input.checkpoint === null) {
    return { sinceIso: new Date(input.bootstrapSince).toISOString() };
  }

  const cursor = Date.parse(input.checkpoint.cursorModifiedAt);
  if (Number.isNaN(cursor)) {
    throw new RangeError(
      `checkpoint for "${input.checkpoint.stream}" has an unparseable cursor: ` +
        input.checkpoint.cursorModifiedAt,
    );
  }

  const overlapMs = Math.max(0, input.lookbackMinutes) * 60_000;
  const since = Math.min(cursor - overlapMs, input.now.getTime());
  return { sinceIso: new Date(since).toISOString() };
}

export interface IngestDeps {
  readonly client: Pick<NetSuiteClient, 'fetchTransactionPage'>;
  readonly gateway: Pick<BigQueryGateway, 'insertTransactions' | 'latestCheckpoint' | 'appendCheckpoint'>;
  readonly logger: Logger;
  readonly pageSize: number;
  readonly maxPages: number;
  readonly lookbackMinutes: number;
  readonly bootstrapSince: string;
  readonly resolveLocationId: (rawLocation: unknown) => string | null;
  readonly now?: () => Date;
}

export interface IngestSummary {
  readonly pages: number;
  readonly rowsRead: number;
  readonly rowsLoaded: number;
  readonly rowsRejected: number;
  readonly rejections: Readonly<Record<string, number>>;
  readonly cursor: { readonly modifiedAt: string; readonly id: string } | null;
}

export async function runTransactionIngest(deps: IngestDeps): Promise<IngestSummary> {
  const now = deps.now ?? ((): Date => new Date());
  const runStartedAt = now();
  const ingestedAt = runStartedAt.toISOString();

  const checkpoint = await deps.gateway.latestCheckpoint(STREAM);
  const { sinceIso } = planStart({
    checkpoint,
    lookbackMinutes: deps.lookbackMinutes,
    bootstrapSince: deps.bootstrapSince,
    now: runStartedAt,
  });

  deps.logger.info('ingest_started', {
    stream: STREAM,
    since: sinceIso,
    resumeFrom: checkpoint === null ? 'bootstrap' : checkpoint.cursorId,
    pageSize: deps.pageSize,
    maxPages: deps.maxPages,
  });

  const facts: TransactionFact[] = [];
  const rejections: Record<string, number> = {};
  let rowsRead = 0;
  let pages = 0;
  let cursor: { modifiedAt: string; id: string } | null = null;

  for (; pages < deps.maxPages; ) {
    const page = await deps.client.fetchTransactionPage({ sinceIso, limit: deps.pageSize });
    if (page.rows.length === 0) break;

    pages += 1;
    rowsRead += page.rows.length;

    for (const row of page.rows) {
      const mapped: MappingResult = mapTransactionRow(row, {
        ingestedAt,
        resolveLocationId: deps.resolveLocationId,
      });

      if (mapped.ok) {
        facts.push(mapped.fact);
      } else {
        rejections[mapped.reason] = (rejections[mapped.reason] ?? 0) + 1;
        deps.logger.warn('ingest_row_rejected', {
          reason: mapped.reason,
          transactionId: mapped.transactionId,
        });
      }
    }

    // The cursor comes from the last RAW row, not the last accepted fact: a page of
    // rejected rows must still move the cursor, or the same page is re-read on
    // every run and the ingest never advances.
    const last = page.rows.at(-1);
    const advanced = last === undefined ? null : cursorOf(last);
    if (advanced !== null) cursor = advanced;

    if (!page.hasMore || page.rows.length < deps.pageSize) break;
  }

  if (facts.length > 0) {
    await deps.gateway.insertTransactions(facts);
  }

  const rowsRejected = Object.values(rejections).reduce((sum, count) => sum + count, 0);

  if (cursor !== null) {
    await deps.gateway.appendCheckpoint({
      stream: STREAM,
      cursorModifiedAt: cursor.modifiedAt,
      cursorId: cursor.id,
      overlapMinutes: deps.lookbackMinutes,
      runStartedAt: ingestedAt,
      pages,
      rowsLoaded: facts.length,
      rowsRejected,
      writtenAt: now().toISOString(),
    });
  }

  const summary: IngestSummary = {
    pages,
    rowsRead,
    rowsLoaded: facts.length,
    rowsRejected,
    rejections,
    cursor,
  };

  deps.logger.info('ingest_finished', {
    ...summary,
    since: sinceIso,
    durationMs: now().getTime() - runStartedAt.getTime(),
  });

  return summary;
}

function cursorOf(row: SuiteQlRow): { modifiedAt: string; id: string } | null {
  const modifiedRaw = row['lastmodifieddate'];
  const idRaw = row['id'];
  if (typeof modifiedRaw !== 'string') return null;
  if (typeof idRaw !== 'string' && typeof idRaw !== 'number') return null;

  const parsed = Date.parse(modifiedRaw);
  if (Number.isNaN(parsed)) return null;

  return { modifiedAt: new Date(parsed).toISOString(), id: String(idRaw) };
}

/** Exported for the test that pins the rejection vocabulary. */
export const REJECTION_REASONS: readonly RejectionReason[] = [
  'missing_id',
  'invalid_trandate',
  'invalid_amount',
  'invalid_lastmodifieddate',
  'unknown_location',
];
