/**
 * Cloud Run **Job** entry point: one ingest run, then exit.
 *
 * Exit code is the contract with Cloud Run: 0 means the run completed. It
 * deliberately does NOT fail when some rows were rejected, because a single bad
 * source row would then block every later run forever and the cursor would never
 * advance. Rejections are counted, logged, and stored in the checkpoint. Only an
 * unrecoverable error (no token, no BigQuery, unreadable checkpoint) exits non-zero.
 */

import { createGateway } from '../bigquery/factory.js';
import { loadIngestConfig } from '../ingest/config.js';
import { runTransactionIngest } from '../ingest/transactions.job.js';
import { createLogger } from '../logger.js';
import { createNetSuiteTokenProvider } from '../netsuite/auth.js';
import { createNetSuiteClient } from '../netsuite/client.js';

const config = loadIngestConfig();
const logger = createLogger({ service: 'gcp-middleware-ingest-job' });

async function main(): Promise<void> {
  const gateway = createGateway(config.job);

  const tokenProvider = createNetSuiteTokenProvider({
    clientId: config.netSuite.clientId,
    certificateId: config.netSuite.certificateId,
    privateKeyPem: config.netSuite.privateKeyPem,
    tokenUrl: `${config.netSuite.baseUrl}/services/rest/auth/oauth2/v1/token`,
    scope: config.netSuite.scope,
  });

  const client = createNetSuiteClient({
    baseUrl: config.netSuite.baseUrl,
    tokenProvider,
  });

  const summary = await runTransactionIngest({
    client,
    gateway,
    logger,
    pageSize: config.ingest.pageSize,
    maxPages: config.ingest.maxPages,
    lookbackMinutes: config.ingest.lookbackMinutes,
    bootstrapSince: config.ingest.bootstrapSince,
    resolveLocationId: (rawLocation) => {
      if (typeof rawLocation !== 'string' && typeof rawLocation !== 'number') return null;
      const key = String(rawLocation).trim();
      return config.ingest.locationMap[key] ?? null;
    },
  });

  logger.info('ingest_summary', {
    pages: summary.pages,
    rowsRead: summary.rowsRead,
    rowsLoaded: summary.rowsLoaded,
    rowsRejected: summary.rowsRejected,
    rejections: summary.rejections,
    cursor: summary.cursor,
  });
}

await main();
