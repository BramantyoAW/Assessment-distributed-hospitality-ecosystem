import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';

import type { Logger } from '../logger.js';
import type { OperaEventsRepo } from '../queue/events.repo.js';
import { createBearerTokenMiddleware } from './auth.middleware.js';

/** Express request carrying the untouched request bytes captured by `verify`. */
export interface RequestWithRawBody extends Request {
  rawBody?: Buffer;
}

/** Stable, log-safe identifier. Rejects newlines and control characters. */
export const EVENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

export interface OperaWebhookDeps {
  readonly repo: OperaEventsRepo;
  readonly logger: Logger;
  readonly bearerToken: string;
}

/**
 * `POST /webhook/opera`
 *
 * Acknowledges with 202 as soon as the event is durably queued. Never talks to
 * NetSuite on this path: the worker owns that.
 */
export function createOperaWebhookRouter(deps: OperaWebhookDeps): Router {
  const router = Router();

  router.post(
    '/',
    requireJsonContentType,
    createBearerTokenMiddleware(deps.bearerToken),
    (req: Request, res: Response) => {
      const rawBody = (req as RequestWithRawBody).rawBody;

      if (rawBody === undefined || rawBody.length === 0) {
        res.status(400).json({ error: 'empty_body' });
        return;
      }

      const eventId = extractEventId(req);
      if (eventId === null) {
        res.status(400).json({ error: 'missing_event_id' });
        return;
      }
      if (!EVENT_ID_PATTERN.test(eventId)) {
        res.status(400).json({ error: 'invalid_event_id' });
        return;
      }

      // Synchronous SQLite write: when this returns, the bytes are durable.
      const outcome = deps.repo.enqueue(eventId, rawBody);

      deps.logger.info('opera_event_accepted', {
        eventId,
        status: outcome,
        bytes: rawBody.length,
      });

      // Duplicates are also 202: from the producer's perspective the event was
      // accepted (on the first delivery). The body distinguishes the outcome.
      res.status(202).json({ status: outcome, eventId });
    },
  );

  return router;
}

function requireJsonContentType(req: Request, res: Response, next: NextFunction): void {
  if (!req.is('application/json')) {
    res.status(415).json({ error: 'unsupported_media_type' });
    return;
  }
  next();
}

function extractEventId(req: Request): string | null {
  const body: unknown = req.body;
  if (typeof body === 'object' && body !== null) {
    const candidate = (body as { eventId?: unknown }).eventId;
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }

  const header = req.get('x-event-id');
  if (typeof header === 'string' && header.length > 0) return header;

  return null;
}
