import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { createApp } from './app.js';
import { createBatcher } from './batch/batcher.js';
import type { BigQueryAdapter } from './bigquery/adapter.js';
import { createBigQueryAdapter } from './bigquery/bigquery.adapter.js';
import { createJsonlAdapter } from './bigquery/jsonl.adapter.js';
import { createRestLoadJobClient } from './bigquery/load-job.rest.js';
import { createMetadataTokenProvider } from './bigquery/token.js';
import { loadIotConfig } from './config.js';
import { createLogger } from './logger.js';
import { IotEventsRepo } from './store/events.repo.js';

const SERVICE = 'edge-middleware-module-2-iot';

const logger = createLogger({ service: SERVICE });
const config = loadIotConfig();

mkdirSync(dirname(config.dbPath), { recursive: true });

const repo = new IotEventsRepo(config.dbPath, { maxAttempts: config.batchMaxAttempts });

// Rows written before `intervalSeconds` existed cannot be shipped and cannot be
// given an invented value. Surface them once at boot instead of leaving them in
// `pending` forever.
const quarantined = repo.quarantineMissingInterval();
if (quarantined > 0) {
  logger.warn('quarantined_pre_contract_rows', {
    count: quarantined,
    hint: 're-send these events from the camera or delete them; they have no interval_seconds',
  });
}

// Rows stranded in `in_flight` belong to a previous process that died mid-flush.
const reclaimed = repo.reclaimInFlight();
if (reclaimed > 0) {
  logger.warn('reclaimed_in_flight_events', { count: reclaimed });
}

const adapter: BigQueryAdapter =
  config.adapter === 'bigquery'
    ? createBigQueryAdapter({
        client: createRestLoadJobClient({
          project: config.bqProject ?? '',
          dataset: config.bqDataset,
          tokenProvider: createMetadataTokenProvider(),
        }),
        table: config.bqTable,
        tempDir: config.bqTempDir,
      })
    : createJsonlAdapter({ sinkPath: config.sinkPath });
const batcher = createBatcher({
  repo,
  adapter,
  logger,
  intervalMs: config.batchIntervalMs,
  maxBatchSize: config.batchMaxSize,
  maxAttempts: config.batchMaxAttempts,
  retryBaseMs: config.batchRetryBaseMs,
  retryMaxMs: config.batchRetryMaxMs,
  shutdownFlushMs: config.shutdownFlushMs,
});

const app = createApp({ config, repo, batcher, logger });

const server = app.listen(config.port, () => {
  logger.info('listening', {
    port: config.port,
    adapter: config.adapter,
    sinkPath: config.sinkPath,
    batchIntervalMs: config.batchIntervalMs,
    batchMaxSize: config.batchMaxSize,
  });
});

batcher.start();

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    logger.warn('shutdown_forced', { signal });
    process.exit(1);
  }
  shuttingDown = true;
  logger.info('shutdown_started', { signal });

  const force = setTimeout(() => {
    logger.error('shutdown_timed_out', { signal });
    process.exit(1);
  }, config.shutdownFlushMs * 2);
  force.unref();

  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  logger.info('http_closed');

  // Drain in-flight rows before the process disappears.
  await batcher.stop();
  logger.info('batcher_stopped');

  repo.close();
  clearTimeout(force);
  logger.info('shutdown_complete', { signal });
  process.exit(0);
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('unhandledRejection', (reason) => {
  logger.error('unhandled_rejection', {
    message: reason instanceof Error ? reason.message : String(reason),
  });
});
