import express from 'express';
import type { ErrorRequestHandler, Express } from 'express';

import type { Batcher } from './batch/batcher.js';
import type { IotConfig } from './config.js';
import { createIotIngestRouter } from './http/ingest.route.js';
import type { Logger } from './logger.js';
import type { IotEventsRepo } from './store/events.repo.js';

export interface AppDeps {
  readonly config: IotConfig;
  readonly repo: IotEventsRepo;
  readonly batcher: Batcher;
  readonly logger: Logger;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(express.json({ limit: deps.config.bodyLimit }));

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', service: 'edge-middleware-module-2-iot' });
  });

  const ingestRouter = createIotIngestRouter({
    repo: deps.repo,
    batcher: deps.batcher,
    logger: deps.logger,
    apiKey: deps.config.apiKey,
    defaultIntervalSeconds: deps.config.defaultIntervalSeconds,
  });

  // The contract path from the assessment brief.
  app.use('/api/v1/iot/people-count', ingestRouter);
  // Day 1 shipped this path and the deploy docs use it. Kept as a plain alias:
  // same router, no extra code, no second contract to keep in sync.
  app.use('/ingest/people-count', ingestRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    const type = (error as { type?: unknown }).type;

    if (type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid_json' });
      return;
    }
    if (type === 'entity.too.large') {
      res.status(413).json({ error: 'payload_too_large' });
      return;
    }

    deps.logger.error('unhandled_request_error', {
      message: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'internal_error' });
  };
  app.use(errorHandler);

  return app;
}
