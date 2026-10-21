import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BigQueryAdapter, IotRow } from './adapter.js';

/**
 * BigQuery adapter: one load job per batch, fed from a temporary NDJSON file.
 *
 * Why a load job and not a streaming insert:
 *   - BigQuery Sandbox rejects `insertAll` and the Storage Write API;
 *   - load jobs are not billed as ingestion;
 *   - a 60-second micro-batch is already a batch, so streaming would pay more
 *     for a shape the design deliberately avoids.
 *
 * `WRITE_APPEND` cannot upsert, so a replayed batch produces duplicate rows.
 * That is accepted, not hidden: `vw_fact_camera_events` keeps one row per
 * `event_id`. The adapter is not allowed to pretend it gives exactly-once.
 *
 * The actual HTTP call lives behind `LoadJobClient` so the orchestration (file
 * writing, schema, cleanup) is testable without a project.
 */

export interface ColumnSchema {
  readonly name: string;
  readonly type: 'STRING' | 'INTEGER' | 'TIMESTAMP' | 'DATE';
  readonly mode: 'REQUIRED' | 'NULLABLE';
}

/**
 * The eight `fact_camera_events` columns, in DDL order.
 *
 * `business_date` is computed by the batcher in `Asia/Makassar`; it is not left
 * to BigQuery because a generated/default column would be invisible to tests and
 * the timezone rule would live where nobody looks.
 */
export const FACT_CAMERA_EVENT_COLUMNS: readonly ColumnSchema[] = [
  { name: 'event_id', type: 'STRING', mode: 'REQUIRED' },
  { name: 'location_id', type: 'STRING', mode: 'REQUIRED' },
  { name: 'business_date', type: 'DATE', mode: 'REQUIRED' },
  { name: 'camera_id', type: 'STRING', mode: 'NULLABLE' },
  { name: 'observed_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
  { name: 'received_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
  { name: 'people_count', type: 'INTEGER', mode: 'REQUIRED' },
  { name: 'interval_seconds', type: 'INTEGER', mode: 'REQUIRED' },
];

export interface LoadJobClient {
  loadNdjson(options: {
    readonly table: string;
    readonly sourcePath: string;
    readonly writeDisposition: 'WRITE_APPEND';
    readonly schema: readonly ColumnSchema[];
  }): Promise<void>;
}

export interface BigQueryAdapterOptions {
  readonly client: LoadJobClient;
  readonly table: string;
  readonly tempDir: string;
  readonly createTempFile?: () => string;
}

export function createBigQueryAdapter(options: BigQueryAdapterOptions): BigQueryAdapter {
  const createTempFile =
    options.createTempFile ?? ((): string => join(options.tempDir, `iot-${randomUUID()}.ndjson`));

  return {
    async insertBatch(rows: readonly IotRow[]): Promise<void> {
      if (rows.length === 0) return;

      mkdirSync(options.tempDir, { recursive: true });
      const sourcePath = createTempFile();

      try {
        writeFileSync(sourcePath, serializeNdjson(rows), 'utf8');
        await options.client.loadNdjson({
          table: options.table,
          sourcePath,
          writeDisposition: 'WRITE_APPEND',
          schema: FACT_CAMERA_EVENT_COLUMNS,
        });
      } finally {
        // Also on failure: a leaked NDJSON file is a small disk leak that grows
        // with every retry, and the rows are already back in SQLite.
        rmSync(sourcePath, { force: true });
      }
    },
  };
}

/** One JSON object per line, snake_case, exactly the column names above. */
export function serializeNdjson(rows: readonly IotRow[]): string {
  return rows.map((row) => `${JSON.stringify(toBigQueryRow(row))}\n`).join('');
}

export function toBigQueryRow(row: IotRow): Record<string, string | number | null> {
  return {
    event_id: row.eventId,
    location_id: row.locationId,
    business_date: row.businessDate,
    camera_id: row.cameraId,
    observed_at: row.observedAt,
    received_at: row.receivedAt,
    people_count: row.peopleCount,
    interval_seconds: row.intervalSeconds,
  };
}
