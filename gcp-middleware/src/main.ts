/**
 * Cloud Run **Service** entry point: the GraphQL API.
 *
 * Boot order matters: configuration is validated before anything listens, so a
 * missing `BQ_PROJECT` or a production run outside Cloud Run fails fast instead of
 * accepting traffic it cannot serve.
 */

import { createGateway } from './bigquery/factory.js';
import { loadServiceConfig } from './config.js';
import { createLogger } from './logger.js';
import { createServer } from './server.js';

const config = loadServiceConfig();
const logger = createLogger({ service: 'gcp-middleware-graphql' });
const gateway = createGateway(config);

const app = createServer({ gateway, logger });

const server = app.listen(config.port, config.host, () => {
  logger.info('listening', {
    port: config.port,
    host: config.host,
    gateway: config.bigquery.gateway,
    dataset: config.bigquery.dataset,
    runsOnCloudRun: config.runsOnCloudRun,
    nodeEnv: config.nodeEnv,
  });
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    logger.warn('shutdown_forced', { signal });
    process.exit(1);
  }
  shuttingDown = true;
  logger.info('shutdown_started', { signal });

  // Cloud Run sends SIGTERM and allows 10s by default. In-flight GraphQL calls
  // are short (bounded by QUERY_TIMEOUT_MS), so closing the listener is enough.
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });

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
