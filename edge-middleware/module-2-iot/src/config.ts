/**
 * Configuration for Module 2 (IoT people-count buffer).
 *
 * Module 2 runs as its own process against its own SQLite file, so its
 * configuration is loaded and validated independently of Module 1.
 */

export type AdapterKind = 'jsonl' | 'bigquery';

export interface IotConfig {
  readonly port: number;
  readonly apiKey: string;
  readonly dbPath: string;
  readonly batchIntervalMs: number;
  readonly batchMaxSize: number;
  readonly batchMaxAttempts: number;
  readonly batchRetryBaseMs: number;
  readonly batchRetryMaxMs: number;
  readonly shutdownFlushMs: number;
  readonly bodyLimit: string;
  readonly adapter: AdapterKind;
  readonly sinkPath: string;
  /**
   * Assumed reading duration when a payload omits `intervalSeconds`. Exposed as
   * configuration, not a constant, so the assumption can be changed without a build.
   */
  readonly defaultIntervalSeconds: number;
  /** BigQuery destination for the load job; unused by the JSONL adapter. */
  readonly bqProject: string | null;
  readonly bqDataset: string;
  readonly bqTable: string;
  readonly bqTempDir: string;
}

const DEFAULTS = {
  port: 3002,
  dbPath: 'data/iot-buffer.db',
  batchIntervalMs: 60_000,
  batchMaxSize: 500,
  batchMaxAttempts: 5,
  batchRetryBaseMs: 1_000,
  batchRetryMaxMs: 60_000,
  shutdownFlushMs: 5_000,
  bodyLimit: '64kb',
  sinkPath: 'data/bigquery-sink.jsonl',
  defaultIntervalSeconds: 60,
  bqDataset: 'finns_hospitality',
  bqTable: 'fact_camera_events',
  bqTempDir: 'data',
} as const;

export function loadIotConfig(env: NodeJS.ProcessEnv = process.env): IotConfig {
  const problems: string[] = [];

  const readRequired = (name: string): string => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') {
      problems.push(`${name} is required and must not be empty`);
      return '';
    }
    return raw.trim();
  };

  const readInt = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      problems.push(`${name} must be an integer in [${min}, ${max}] (got "${raw}")`);
      return fallback;
    }
    return parsed;
  };

  const apiKey = readRequired('IOT_API_KEY');

  const rawAdapter = (env['BQ_ADAPTER'] ?? 'jsonl').trim().toLowerCase();
  const adapter: AdapterKind = rawAdapter === 'bigquery' ? 'bigquery' : 'jsonl';
  // Refuse to boot with an adapter that does not exist rather than silently
  // buffering rows that will never be delivered.
  if (rawAdapter !== 'jsonl' && rawAdapter !== 'bigquery') {
    problems.push(`BQ_ADAPTER must be "jsonl" or "bigquery" (got "${rawAdapter}")`);
  }

  const bqProject = env['BQ_PROJECT']?.trim() || null;
  if (adapter === 'bigquery' && bqProject === null) {
    problems.push('BQ_PROJECT is required when BQ_ADAPTER=bigquery');
  }

  const config: IotConfig = {
    port: readInt('IOT_PORT', DEFAULTS.port, 1, 65_535),
    apiKey,
    dbPath: env['IOT_DB_PATH']?.trim() || DEFAULTS.dbPath,
    batchIntervalMs: readInt('BATCH_INTERVAL_MS', DEFAULTS.batchIntervalMs, 100, 3_600_000),
    batchMaxSize: readInt('BATCH_MAX_SIZE', DEFAULTS.batchMaxSize, 1, 10_000),
    batchMaxAttempts: readInt('BATCH_MAX_ATTEMPTS', DEFAULTS.batchMaxAttempts, 1, 100),
    batchRetryBaseMs: readInt('BATCH_RETRY_BASE_MS', DEFAULTS.batchRetryBaseMs, 0, 3_600_000),
    batchRetryMaxMs: readInt('BATCH_RETRY_MAX_MS', DEFAULTS.batchRetryMaxMs, 0, 86_400_000),
    shutdownFlushMs: readInt('SHUTDOWN_FLUSH_MS', DEFAULTS.shutdownFlushMs, 0, 120_000),
    bodyLimit: env['IOT_BODY_LIMIT']?.trim() || DEFAULTS.bodyLimit,
    adapter,
    sinkPath: env['BQ_SINK_PATH']?.trim() || DEFAULTS.sinkPath,
    defaultIntervalSeconds: readInt(
      'IOT_DEFAULT_INTERVAL_SECONDS',
      DEFAULTS.defaultIntervalSeconds,
      1,
      3_600,
    ),
    bqProject,
    bqDataset: env['BQ_DATASET']?.trim() || DEFAULTS.bqDataset,
    bqTable: env['BQ_TABLE']?.trim() || DEFAULTS.bqTable,
    bqTempDir: env['BQ_TEMP_DIR']?.trim() || DEFAULTS.bqTempDir,
  };

  if (config.batchRetryBaseMs > config.batchRetryMaxMs) {
    problems.push('BATCH_RETRY_BASE_MS must not exceed BATCH_RETRY_MAX_MS');
  }

  if (problems.length > 0) {
    throw new Error(`Invalid IoT configuration:\n  - ${problems.join('\n  - ')}`);
  }

  return config;
}
