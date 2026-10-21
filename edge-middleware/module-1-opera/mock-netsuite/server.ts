import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import express from 'express';
import type { Express } from 'express';

import type { RequestWithRawBody } from '../src/http/webhook.route.js';
import {
  DEFAULT_CLOCK_SKEW_SECONDS,
  HEADER_IDEMPOTENCY,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  buildCanonicalString,
  isTimestampFresh,
  verifySignature,
} from '../src/netsuite/signer.js';

/**
 * Local stand-in for the NetSuite ERP endpoint.
 *
 * It does real work: verifies the HMAC over the exact bytes it received, applies
 * the replay window, honours Idempotency-Key, and can be told to fail so retry
 * behaviour is exercised against a server rather than a stub.
 */

export type FailMode = 'never' | 'always' | 'once';

export interface MockNetsuiteOptions {
  readonly hmacSecret: string;
  readonly clockSkewSeconds?: number;
  readonly failMode?: FailMode;
  readonly receivedLogPath?: string;
}

export interface MockNetsuiteState {
  failMode: FailMode;
  received: number;
  duplicate: number;
  rejected: number;
  lastBody: string | null;
}

export interface MockNetsuite {
  readonly app: Express;
  readonly state: MockNetsuiteState;
  setFailMode(mode: FailMode): void;
  reset(): void;
}

export function createMockNetsuite(options: MockNetsuiteOptions): MockNetsuite {
  const clockSkewSeconds = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  const seen = new Set<string>();

  const state: MockNetsuiteState = {
    failMode: options.failMode ?? 'never',
    received: 0,
    duplicate: 0,
    rejected: 0,
    lastBody: null,
  };

  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as RequestWithRawBody).rawBody = Buffer.from(buf);
      },
    }),
  );

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', service: 'mock-netsuite', failMode: state.failMode });
  });

  app.get('/__state', (_req, res) => {
    res.json({ ...state, seen: [...seen] });
  });

  app.post('/__control', (req, res) => {
    const body = req.body as { failMode?: unknown; reset?: unknown };

    if (body.failMode === 'never' || body.failMode === 'always' || body.failMode === 'once') {
      state.failMode = body.failMode;
    }
    if (body.reset === true) {
      seen.clear();
      state.received = 0;
      state.duplicate = 0;
      state.rejected = 0;
      state.lastBody = null;
    }

    res.json({ failMode: state.failMode });
  });

  app.post('/api/v1/opera/events', (req, res) => {
    const rawBody = (req as RequestWithRawBody).rawBody;
    if (rawBody === undefined) {
      state.rejected += 1;
      res.status(400).json({ error: 'missing_body' });
      return;
    }

    const timestamp = req.get(HEADER_TIMESTAMP) ?? '';
    const signature = req.get(HEADER_SIGNATURE) ?? '';
    const idempotencyKey = req.get(HEADER_IDEMPOTENCY) ?? '';

    if (!isTimestampFresh(timestamp, Math.floor(Date.now() / 1000), clockSkewSeconds)) {
      state.rejected += 1;
      res.status(401).json({ error: 'stale_timestamp' });
      return;
    }

    const canonical = buildCanonicalString({
      method: 'POST',
      path: req.originalUrl,
      timestamp,
      body: rawBody,
    });

    if (!verifySignature(signature, canonical, options.hmacSecret)) {
      state.rejected += 1;
      res.status(401).json({ error: 'bad_signature' });
      return;
    }

    if (idempotencyKey !== '' && seen.has(idempotencyKey)) {
      state.duplicate += 1;
      res.status(200).json({ status: 'duplicate', id: idempotencyKey });
      return;
    }

    if (state.failMode === 'always' || state.failMode === 'once') {
      if (state.failMode === 'once') state.failMode = 'never';
      state.rejected += 1;
      res.status(503).json({ error: 'injected_failure' });
      return;
    }

    seen.add(idempotencyKey);
    state.received += 1;
    state.lastBody = rawBody.toString('utf8');

    if (options.receivedLogPath !== undefined) {
      mkdirSync(dirname(options.receivedLogPath), { recursive: true });
      appendFileSync(
        options.receivedLogPath,
        `${JSON.stringify({ at: new Date().toISOString(), eventId: idempotencyKey, body: state.lastBody })}\n`,
      );
    }

    res.status(201).json({ status: 'accepted', id: idempotencyKey });
  });

  return {
    app,
    state,
    setFailMode(mode: FailMode): void {
      state.failMode = mode;
    },
    reset(): void {
      seen.clear();
      state.received = 0;
      state.duplicate = 0;
      state.rejected = 0;
      state.lastBody = null;
    },
  };
}
