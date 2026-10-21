import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { ColumnSchema, LoadJobClient } from './bigquery.adapter.js';
import type { TokenProvider } from './token.js';

/**
 * BigQuery REST transport for the load job.
 *
 * Hand-written against the documented REST endpoint instead of pulling in
 * `@google-cloud/bigquery`: one multipart POST, ~60 lines, no dependency whose
 * own transitive tree would need auditing. The endpoint and the multipart shape
 * are the parts that can be wrong, and `load-job.rest.test.ts` pins both against
 * an injected `fetch`.
 *
 * Live behaviour (a job actually accepted by BigQuery) is unverified here: there
 * is no project or credential on this machine. The exact command to verify it is
 * in `deploy/cloudrun.md`.
 */

export interface RestLoadJobClientOptions {
  readonly project: string;
  readonly dataset: string;
  readonly tokenProvider: TokenProvider;
  readonly fetch?: typeof fetch;
  readonly jobId?: () => string;
  readonly endpoint?: string;
}

export function createRestLoadJobClient(options: RestLoadJobClientOptions): LoadJobClient {
  const fetchImpl = options.fetch ?? fetch;
  const makeJobId = options.jobId ?? randomUUID;
  const endpoint =
    options.endpoint ?? 'https://bigquery.googleapis.com/upload/bigquery/v2/projects';

  return {
    async loadNdjson({ table, sourcePath, writeDisposition, schema }): Promise<void> {
      const token = await options.tokenProvider.getAccessToken();
      const jobId = makeJobId();
      const { body, contentType } = buildMultipartBody({
        jobId,
        project: options.project,
        dataset: options.dataset,
        table,
        writeDisposition,
        schema,
        ndjson: readFileSync(sourcePath),
      });

      const response = await fetchImpl(
        `${endpoint}/${options.project}/jobs?uploadType=multipart`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
          body,
        },
      );

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(
          `bigquery load job failed: ${response.status} ${detail.slice(0, 300)}`,
        );
      }
    },
  };
}

export interface MultipartInput {
  readonly jobId: string;
  readonly project: string;
  readonly dataset: string;
  readonly table: string;
  readonly writeDisposition: 'WRITE_APPEND';
  readonly schema: readonly ColumnSchema[];
  readonly ndjson: Buffer;
}

/** Exported so a test can assert the exact job configuration without a network. */
export function buildJobConfiguration(input: MultipartInput): Record<string, unknown> {
  return {
    jobReference: { projectId: input.project, jobId: input.jobId },
    configuration: {
      load: {
        destinationTable: {
          projectId: input.project,
          datasetId: input.dataset,
          tableId: input.table,
        },
        sourceFormat: 'NEWLINE_DELIMITED_JSON',
        writeDisposition: input.writeDisposition,
        // Explicit schema: autodetect would let the first batch decide the types,
        // so one batch of nulls could create a STRING column.
        autodetect: false,
        schema: {
          fields: input.schema.map((column) => ({
            name: column.name,
            type: column.type,
            mode: column.mode,
          })),
        },
      },
    },
  };
}

export function buildMultipartBody(input: MultipartInput): {
  readonly body: Buffer;
  readonly contentType: string;
} {
  const boundary = `finns-load-${input.jobId}`;
  const jobJson = JSON.stringify(buildJobConfiguration(input));

  const preamble = Buffer.from(
    `--${boundary}\r\n` +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      `${jobJson}\r\n` +
      `--${boundary}\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n',
    'utf8',
  );
  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');

  return {
    body: Buffer.concat([preamble, input.ndjson, epilogue]),
    contentType: `multipart/related; boundary=${boundary}`,
  };
}
