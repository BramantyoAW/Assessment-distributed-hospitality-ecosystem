/**
 * The real warehouse gateway: BigQuery, reached through the official client.
 *
 * Two constraints shape this file.
 *
 * 1. No DML and no streaming inserts. The chosen BigQuery environment is the
 *    Sandbox, which rejects `insertAll`, the Storage Write API and `MERGE`. Every
 *    write is therefore a load job (`WRITE_APPEND`) fed from an NDJSON file, and
 *    every read is a query against the dedupe views.
 * 2. `WRITE_APPEND` cannot upsert, so a replayed batch appends duplicate rows and
 *    the views are what make the numbers correct. This class does not pretend
 *    otherwise; `vw_fact_*` is the guarantee.
 *
 * Live verification status: NOT EXECUTED. There is no GCP project or credential on
 * the development machine. `deploy/cloudrun.md` lists the exact commands.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BigQuery } from '@google-cloud/bigquery';
import type { Query } from '@google-cloud/bigquery';

import type {
  BigQueryGateway,
  CameraEventFact,
  CheckpointRecord,
  ConversionRecord,
  LocationRecord,
  OccurredAtSource,
  TransactionFact,
  TransactionQuery,
  VisitBucket,
  VisitorCountQuery,
  VisitorCountRecord,
} from './gateway.js';
import {
  CHECKPOINT_LATEST_SQL,
  CONVERSION_METRICS_SQL,
  LOCATIONS_SQL,
  TRANSACTIONS_SQL,
  visitorCountsSql,
} from './queries.js';

export interface BigQueryGatewayOptions {
  readonly project: string;
  readonly dataset: string;
  readonly location: string;
  readonly queryTimeoutMs: number;
  /** Injected in tests; the default authenticates through ADC. */
  readonly client?: BigQuery;
}

interface FieldSpec {
  readonly name: string;
  readonly type: string;
  readonly mode: 'REQUIRED' | 'NULLABLE';
}

const TRANSACTION_FIELDS: readonly FieldSpec[] = [
  { name: 'transaction_id', type: 'STRING', mode: 'REQUIRED' },
  { name: 'location_id', type: 'STRING', mode: 'REQUIRED' },
  { name: 'business_date', type: 'DATE', mode: 'REQUIRED' },
  { name: 'occurred_at', type: 'TIMESTAMP', mode: 'NULLABLE' },
  { name: 'occurred_at_source', type: 'STRING', mode: 'REQUIRED' },
  { name: 'source_created_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
  { name: 'source_modified_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
  { name: 'amount', type: 'NUMERIC', mode: 'REQUIRED' },
  { name: 'currency', type: 'STRING', mode: 'REQUIRED' },
  { name: 'txn_type', type: 'STRING', mode: 'REQUIRED' },
  { name: 'guests', type: 'INTEGER', mode: 'NULLABLE' },
  { name: 'source_system', type: 'STRING', mode: 'REQUIRED' },
  { name: 'ingested_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
];

const CAMERA_FIELDS: readonly FieldSpec[] = [
  { name: 'event_id', type: 'STRING', mode: 'REQUIRED' },
  { name: 'location_id', type: 'STRING', mode: 'REQUIRED' },
  { name: 'business_date', type: 'DATE', mode: 'REQUIRED' },
  { name: 'camera_id', type: 'STRING', mode: 'NULLABLE' },
  { name: 'observed_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
  { name: 'received_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
  { name: 'people_count', type: 'INTEGER', mode: 'REQUIRED' },
  { name: 'interval_seconds', type: 'INTEGER', mode: 'REQUIRED' },
];

const CHECKPOINT_FIELDS: readonly FieldSpec[] = [
  { name: 'stream', type: 'STRING', mode: 'REQUIRED' },
  { name: 'cursor_modified_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
  { name: 'cursor_id', type: 'STRING', mode: 'REQUIRED' },
  { name: 'overlap_minutes', type: 'INTEGER', mode: 'REQUIRED' },
  { name: 'run_started_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
  { name: 'pages', type: 'INTEGER', mode: 'REQUIRED' },
  { name: 'rows_loaded', type: 'INTEGER', mode: 'REQUIRED' },
  { name: 'rows_rejected', type: 'INTEGER', mode: 'REQUIRED' },
  { name: 'written_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
];

export function createBigQueryGateway(options: BigQueryGatewayOptions): BigQueryGateway {
  const client =
    options.client ??
    new BigQuery({ projectId: options.project, location: options.location });

  const defaultDataset = { projectId: options.project, datasetId: options.dataset };

  const query = async (
    sql: string,
    params: Record<string, unknown>,
    types: Record<string, string | readonly string[]>,
  ): Promise<Record<string, unknown>[]> => {
    const [rows] = await client.query({
      query: sql,
      params,
      useLegacySql: false,
      defaultDataset,
      location: options.location,
      jobTimeoutMs: options.queryTimeoutMs,
      // The client's TypeScript definition for `types` only admits the positional
      // form, while the documented named-parameter form is an object keyed by
      // parameter name. The cast is confined to this one call.
      ...(Object.keys(types).length > 0 ? { types } : {}),
    } as unknown as Query);

    return rows as Record<string, unknown>[];
  };

  const load = async (
    table: string,
    fields: readonly FieldSpec[],
    rows: readonly Record<string, unknown>[],
  ): Promise<void> => {
    if (rows.length === 0) return;

    const directory = mkdtempSync(join(tmpdir(), 'finns-load-'));
    const sourcePath = join(directory, `${table}.ndjson`);

    try {
      writeFileSync(
        sourcePath,
        rows.map((row) => `${JSON.stringify(row)}\n`).join(''),
        'utf8',
      );

      await client
        .dataset(options.dataset)
        .table(table)
        .load(sourcePath, {
          sourceFormat: 'NEWLINE_DELIMITED_JSON',
          writeDisposition: 'WRITE_APPEND',
          schema: { fields: fields.map((field) => ({ ...field })) },
        });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };

  return {
    insertTransactions: async (rows) =>
      load('fact_transactions', TRANSACTION_FIELDS, rows.map(toTransactionRow)),

    insertCameraEvents: async (rows) =>
      load('fact_camera_events', CAMERA_FIELDS, rows.map(toCameraRow)),

    readTransactions: async (): Promise<readonly TransactionFact[]> => {
      const rows = await query(
        `SELECT * FROM vw_fact_transactions`,
        {},
        {},
      );
      return rows.map(fromTransactionRow);
    },

    readCameraEvents: async (): Promise<readonly CameraEventFact[]> => {
      const rows = await query(`SELECT * FROM vw_fact_camera_events`, {}, {});
      return rows.map(fromCameraRow);
    },

    listLocations: async (): Promise<readonly LocationRecord[]> => {
      const rows = await query(LOCATIONS_SQL, {}, {});
      return rows.map((row) => ({
        locationId: String(row['location_id']),
        name: String(row['name']),
        area: row['area'] === null ? null : String(row['area']),
        capacity: row['capacity'] === null ? null : Number(row['capacity']),
        isOutdoor: row['is_outdoor'] === true,
        timezone: String(row['timezone']),
        openedOn: row['opened_on'] === null ? null : String(row['opened_on']),
      }));
    },

    listTransactions: async (request: TransactionQuery): Promise<readonly TransactionFact[]> => {
      const rows = await query(
        TRANSACTIONS_SQL,
        {
          location_id: request.locationId,
          from_date: request.from,
          to_date: request.to,
          row_limit: request.limit,
        },
        { location_id: 'STRING', from_date: 'DATE', to_date: 'DATE', row_limit: 'INT64' },
      );
      return rows.map(fromTransactionRow);
    },

    visitorCounts: async (
      request: VisitorCountQuery,
    ): Promise<readonly VisitorCountRecord[]> => {
      const rows = await query(
        visitorCountsSql(request.bucket satisfies VisitBucket),
        {
          location_id: request.locationId,
          from_date: request.from,
          to_date: request.to,
          row_limit: request.limit,
        },
        { location_id: 'STRING', from_date: 'DATE', to_date: 'DATE', row_limit: 'INT64' },
      );

      return rows.map((row) => ({
        locationId: String(row['location_id']),
        bucketStart: toIsoString(row['bucket_start']),
        visits: Number(row['visits']),
        readings: Number(row['readings']),
        cameraSeconds: Number(row['camera_seconds']),
      }));
    },

    conversionMetrics: async (keys): Promise<readonly ConversionRecord[]> => {
      // Duplicate keys would join the facts twice and double `SUM(amount)`.
      const unique = new Map(keys.map((key) => [`${key.locationId}|${key.businessDate}`, key]));
      const ordered = [...unique.values()];
      if (ordered.length === 0) return [];

      const rows = await query(
        CONVERSION_METRICS_SQL,
        {
          location_ids: ordered.map((key) => key.locationId),
          business_dates: ordered.map((key) => key.businessDate),
        },
        { location_ids: ['STRING'], business_dates: ['DATE'] },
      );

      return rows.map((row) => ({
        locationId: String(row['location_id']),
        businessDate: String(row['business_date']),
        totalTransactions: Number(row['total_transactions']),
        totalRevenue: toDecimalString(row['total_revenue']),
        totalVisits: Number(row['total_visits']),
        totalReadings: Number(row['total_readings']),
        cameraSeconds: Number(row['camera_seconds']),
        conversionRate:
          row['conversion_rate'] === null || row['conversion_rate'] === undefined
            ? null
            : Number(row['conversion_rate']),
      }));
    },

    latestCheckpoint: async (stream): Promise<CheckpointRecord | null> => {
      const rows = await query(CHECKPOINT_LATEST_SQL, { stream }, { stream: 'STRING' });
      const row = rows[0];
      if (row === undefined) return null;

      return {
        stream: String(row['stream']),
        cursorModifiedAt: toIsoString(row['cursor_modified_at']),
        cursorId: String(row['cursor_id']),
        overlapMinutes: Number(row['overlap_minutes']),
        runStartedAt: toIsoString(row['run_started_at']),
        pages: Number(row['pages']),
        rowsLoaded: Number(row['rows_loaded']),
        rowsRejected: Number(row['rows_rejected']),
        writtenAt: toIsoString(row['written_at']),
      };
    },

    appendCheckpoint: async (record) =>
      load('ingest_checkpoint', CHECKPOINT_FIELDS, [
        {
          stream: record.stream,
          cursor_modified_at: record.cursorModifiedAt,
          cursor_id: record.cursorId,
          overlap_minutes: record.overlapMinutes,
          run_started_at: record.runStartedAt,
          pages: record.pages,
          rows_loaded: record.rowsLoaded,
          rows_rejected: record.rowsRejected,
          written_at: record.writtenAt,
        },
      ]),
  };
}

function toTransactionRow(row: TransactionFact): Record<string, unknown> {
  return {
    transaction_id: row.transactionId,
    location_id: row.locationId,
    business_date: row.businessDate,
    occurred_at: row.occurredAt,
    occurred_at_source: row.occurredAtSource,
    source_created_at: row.sourceCreatedAt ?? row.sourceModifiedAt,
    source_modified_at: row.sourceModifiedAt,
    amount: row.amount,
    currency: row.currency,
    txn_type: row.txnType,
    guests: row.guests,
    source_system: row.sourceSystem,
    ingested_at: row.ingestedAt,
  };
}

function toCameraRow(row: CameraEventFact): Record<string, unknown> {
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

function fromTransactionRow(row: Record<string, unknown>): TransactionFact {
  const source = row['occurred_at_source'];
  return {
    transactionId: String(row['transaction_id']),
    locationId: String(row['location_id']),
    businessDate: toDateString(row['business_date']),
    occurredAt: row['occurred_at'] === null ? null : toIsoString(row['occurred_at']),
    occurredAtSource: (source === 'record' ? 'record' : 'unavailable') satisfies OccurredAtSource,
    sourceCreatedAt:
      row['source_created_at'] === null ? null : toIsoString(row['source_created_at']),
    sourceModifiedAt: toIsoString(row['source_modified_at']),
    amount: toDecimalString(row['amount']),
    currency: String(row['currency']),
    txnType: String(row['txn_type']),
    guests: row['guests'] === null ? null : Number(row['guests']),
    sourceSystem: String(row['source_system']),
    ingestedAt: toIsoString(row['ingested_at']),
  };
}

function fromCameraRow(row: Record<string, unknown>): CameraEventFact {
  return {
    eventId: String(row['event_id']),
    locationId: String(row['location_id']),
    businessDate: toDateString(row['business_date']),
    cameraId: row['camera_id'] === null ? null : String(row['camera_id']),
    observedAt: toIsoString(row['observed_at']),
    receivedAt: toIsoString(row['received_at']),
    peopleCount: Number(row['people_count']),
    intervalSeconds: Number(row['interval_seconds']),
  };
}

/** BigQuery DATE and TIMESTAMP come back as wrappers with a `value` field. */
function toIsoString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && value !== null && 'value' in value) {
    return String((value as { value: unknown }).value);
  }
  return String(value);
}

function toDateString(value: unknown): string {
  return toIsoString(value).slice(0, 10);
}

function toDecimalString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value.toFixed(2);
  if (typeof value === 'object' && value !== null && 'value' in value) {
    return String((value as { value: unknown }).value);
  }
  return String(value);
}
