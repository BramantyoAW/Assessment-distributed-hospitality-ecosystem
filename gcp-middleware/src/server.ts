/**
 * HTTP surface of the GraphQL service: exactly two routes.
 *
 *   POST /graphql  - the only data route
 *   GET  /healthz  - liveness
 *
 * There is no ingest route. Ingest is a Cloud Run **Job** (`jobs/transactions.ts`),
 * because an ingest endpoint on this service would be a second privileged entry
 * point that Cloud Run IAM does not distinguish from a read: any caller allowed to
 * run a query could also trigger a write. A separate job keeps the blast radius
 * equal to the permission list.
 *
 * GET /graphql is refused with 405 rather than serving a playground. Everything on
 * this service is behind invoker-only IAM, so a browser UI would be a convenient
 * way to burn the caller's quota and to advertise the schema to anyone who has the
 * URL. `/healthz` is IAM-protected too: Cloud Run's gate sits in front of all
 * routes, and only `roles/run.invoker` holders reach it.
 */

import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { GraphQLError, graphql } from 'graphql';

import type { BigQueryGateway } from './bigquery/gateway.js';
import { createLoaders } from './dataloader/loaders.js';
import type { Logger } from './logger.js';
import { assertDepth } from './schema/guard.js';
import { createSchema } from './schema/index.js';
import type { GraphQLContext } from './schema/resolvers.js';

export interface ServerDeps {
  readonly gateway: BigQueryGateway;
  readonly logger: Logger;
  readonly maxBodySize?: string;
}

interface GraphQLBody {
  readonly query?: unknown;
  readonly variables?: unknown;
  readonly operationName?: unknown;
}

export function createServer(deps: ServerDeps): Express {
  const app = express();
  // The schema is built once: rebuilding per request would re-parse the SDL and
  // re-attach resolvers on every call.
  const schema = createSchema();

  app.disable('x-powered-by');
  app.use(express.json({ limit: deps.maxBodySize ?? '256kb' }));

  app.get('/healthz', (_request: Request, response: Response) => {
    response.status(200).json({ status: 'ok' });
  });

  app.get('/graphql', (_request: Request, response: Response) => {
    response.status(405).json({ errors: [{ message: 'use POST /graphql' }] });
  });

  app.post('/graphql', async (request: Request, response: Response) => {
    const body = request.body as GraphQLBody | undefined;
    if (body === undefined || typeof body.query !== 'string' || body.query.trim() === '') {
      response.status(400).json({ errors: [{ message: 'query is required' }] });
      return;
    }

    try {
      assertDepth(body.query);
    } catch (error) {
      const message = error instanceof GraphQLError ? error.message : 'query could not be parsed';
      deps.logger.warn('graphql_rejected', { reason: message });
      response.status(400).json({ errors: [{ message }] });
      return;
    }

    // Fresh loaders per request: a DataLoader caches, and a cache shared between
    // requests would serve one caller's rows to another (and never see an update).
    const context: GraphQLContext = {
      gateway: deps.gateway,
      loaders: createLoaders(deps.gateway),
    };

    const result = await graphql({
      schema,
      source: body.query,
      contextValue: context,
      variableValues:
        typeof body.variables === 'object' && body.variables !== null
          ? (body.variables as Record<string, unknown>)
          : undefined,
      operationName: typeof body.operationName === 'string' ? body.operationName : undefined,
    });

    // 400 only when nothing was produced: a partial response with errors is a 200,
    // because the client did get data and GraphQL says so in the payload.
    const status = result.data === undefined && result.errors !== undefined ? 400 : 200;
    if (result.errors !== undefined) {
      deps.logger.warn('graphql_errors', {
        count: result.errors.length,
        first: result.errors[0]?.message ?? '',
      });
    }

    response.status(status).json(result);
  });

  app.use((_request: Request, response: Response) => {
    response.status(404).json({ errors: [{ message: 'not found' }] });
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const status = statusFor(error);
    deps.logger.error('http_error', {
      status,
      message: error instanceof Error ? error.message : String(error),
    });
    response.status(status).json({
      errors: [{ message: status === 500 ? 'internal error' : 'invalid request body' }],
    });
  });

  return app;
}

function statusFor(error: unknown): number {
  const type = (error as { type?: string } | null)?.type;
  if (type === 'entity.parse.failed') return 400;
  if (type === 'entity.too.large') return 413;
  return 500;
}
