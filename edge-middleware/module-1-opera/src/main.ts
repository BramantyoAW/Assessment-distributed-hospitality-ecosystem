import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { createApp } from './app.js';
import { loadOperaConfig } from './config.js';
import { createLogger } from './logger.js';
import { createNetsuiteClient } from './netsuite/client.js';
import { OperaEventsRepo } from './queue/events.repo.js';
import { createOperaWorker } from './queue/worker.js';

const SERVICE = 'edge-middleware-module-1-opera';

const logger = createLogger({ service: SERVICE });
const config = loadOperaConfig();

mkdirSync(dirname(config.dbPath), { recursive: true });

const repo = new OperaEventsRepo(config.dbPath, { maxAttempts: config.maxAttempts });

// Rows left in `processing` belong to a previous process that died mid-flight.
const reclaimed = repo.reclaimStale();
if (reclaimed > 0) {
  logger.warn('reclaimed_stale_events', { count: reclaimed });
}

const client = createNetsuiteClient(config);
const worker = createOperaWorker({
  repo,
  client,
  logger,
  pollIntervalMs: config.pollIntervalMs,
  retryBaseMs: config.retryBaseMs,
  retryMaxDelayMs: config.retryMaxDelayMs,
  shutdownGraceMs: config.shutdownGraceMs,
});

const app = createApp({ config, repo, logger });

const server = app.listen(config.port, () => {
  logger.info('listening', { port: config.port, netsuiteUrl: config.netsuiteUrl });
});

worker.start();

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    logger.warn('shutdown_forced', { signal });
    process.exit(1);
  }
  shuttingDown = true;
  logger.info('shutdown_started', { signal });

  // Backstop: never hang a systemd stop/restart for longer than this.
  const force = setTimeout(() => {
    logger.error('shutdown_timed_out', { signal });
    process.exit(1);
  }, config.shutdownGraceMs * 2);
  force.unref();

  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  logger.info('http_closed');

  await worker.stop();
  logger.info('worker_stopped');

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
