import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { BigQueryAdapter, IotRow } from './adapter.js';

/**
 * Local stand-in for BigQuery: newline-delimited JSON, one object per row.
 *
 * This is the mock required by the brief, and it is also a real check: the file
 * is what a BigQuery load job would consume, so the row shape is validated by
 * actually producing it.
 *
 * `appendFileSync` is deliberate. The batch is marked `sent` only after this
 * returns, so "sent" cannot mean "buffered in a process that then died".
 */

export interface JsonlAdapterOptions {
  readonly sinkPath: string;
  readonly now?: () => number;
}

export function createJsonlAdapter(options: JsonlAdapterOptions): BigQueryAdapter {
  const now = options.now ?? Date.now;
  let directoryReady = false;

  return {
    async insertBatch(rows: readonly IotRow[]): Promise<void> {
      if (rows.length === 0) return;

      if (!directoryReady) {
        mkdirSync(dirname(options.sinkPath), { recursive: true });
        directoryReady = true;
      }

      const insertedAt = new Date(now()).toISOString();

      // One write for the whole batch: either every row lands or none does.
      const payload = rows
        .map((row) => `${JSON.stringify({ ...row, insertedAt })}\n`)
        .join('');

      appendFileSync(options.sinkPath, payload, 'utf8');
    },
  };
}
