import express from 'express';
import type { ErrorRequestHandler, Express } from 'express';

import type { OperaConfig } from './config.js';
import { createOperaWebhookRouter } from './http/webhook.route.js';
import type { RequestWithRawBody } from './http/webhook.route.js';
import type { Logger } from './logger.js';
import type { OperaEventsRepo } from './queue/events.repo.js';

export interface AppDeps {
  readonly config: OperaConfig;
  readonly repo: OperaEventsRepo;
  readonly logger: Logger;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(
    express.json({
      limit: deps.config.bodyLimit,
      /**
       * `verify` runs after the body is buffered but BEFORE JSON.parse, and it
       * is the only place the original bytes still exist. They are copied with
       * Buffer.from because the parser may reuse its buffer afterwards.
       *
       * Everything downstream (SQLite payload, HMAC signature, NetSuite body)
       * uses these bytes. `JSON.stringify(req.body)` is not a substitute: it
       * normalises whitespace, key order and unicode escapes, which changes the
       * hash and makes the signature unverifiable.
       */
      verify: (req, _res, buf) => {
        (req as RequestWithRawBody).rawBody = Buffer.from(buf);
      },
    }),
  );

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', service: 'edge-middleware-module-1-opera' });
  });

  app.use(
    '/webhook/opera',
    createOperaWebhookRouter({
      repo: deps.repo,
      logger: deps.logger,
      bearerToken: deps.config.bearerToken,
    }),
  );

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
