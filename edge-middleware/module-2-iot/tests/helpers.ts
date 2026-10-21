import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import type { Express } from 'express';

import { createApp } from '../src/app.js';
import { createBatcher } from '../src/batch/batcher.js';
import type { Batcher } from '../src/batch/batcher.js';
import type { BigQueryAdapter, IotRow } from '../src/bigquery/adapter.js';
import type { IotConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import type { Logger } from '../src/logger.js';
import { IotEventsRepo } from '../src/store/events.repo.js';

export const API_KEY = 'test-api-key';

export interface TestServer {
  readonly url: string;
  close(): Promise<void>;
}

export function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dhe-module-2-'));
}

export function createTestConfig(overrides: Partial<IotConfig> = {}): IotConfig {
  return {
    port: 0,
    apiKey: API_KEY,
    dbPath: ':memory:',
    // Long interval: the timer must not fire during a request-level test.
    batchIntervalMs: 60_000,
    batchMaxSize: 500,
    batchMaxAttempts: 3,
    batchRetryBaseMs: 0,
    batchRetryMaxMs: 0,
    shutdownFlushMs: 200,
    bodyLimit: '16kb',
    adapter: 'jsonl',
    sinkPath: join(makeTempDir(), 'unused.jsonl'),
    defaultIntervalSeconds: 60,
    bqProject: null,
    bqDataset: 'finns_hospitality',
    bqTable: 'fact_camera_events',
    bqTempDir: makeTempDir(),
    ...overrides,
  };
}

export function silentLogger(): Logger {
  return createLogger({ service: 'test', sink: () => {} });
}

export async function listen(app: Express): Promise<TestServer> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });

  const address = server.address() as AddressInfo | null;
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP address from the test server');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

export interface RecorderAdapter extends BigQueryAdapter {
  /** Every batch the adapter accepted, in order. */
  readonly batches: IotRow[][];
  failNext(message?: string): void;
  totalRows(): number;
}

export function createRecorderAdapter(): RecorderAdapter {
  const batches: IotRow[][] = [];
  const pendingFailures: string[] = [];

  return {
    batches,
    failNext(message = 'injected adapter failure'): void {
      pendingFailures.push(message);
    },
    totalRows(): number {
      return batches.reduce((sum, batch) => sum + batch.length, 0);
    },
    async insertBatch(rows: readonly IotRow[]): Promise<void> {
      const failure = pendingFailures.shift();
      if (failure !== undefined) throw new Error(failure);
      batches.push([...rows]);
    },
  };
}

export interface Harness {
  readonly url: string;
  readonly repo: IotEventsRepo;
  readonly batcher: Batcher;
  readonly adapter: RecorderAdapter;
  readonly config: IotConfig;
  close(): Promise<void>;
}

export async function startHarness(overrides: Partial<IotConfig> = {}): Promise<Harness> {
  const config = createTestConfig(overrides);
  const logger = silentLogger();
  const repo = new IotEventsRepo(config.dbPath, { maxAttempts: config.batchMaxAttempts });
  const adapter = createRecorderAdapter();

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
  const server = await listen(app);

  return {
    url: server.url,
    repo,
    batcher,
    adapter,
    config,
    async close(): Promise<void> {
      await server.close();
      await batcher.stop();
      repo.close();
    },
  };
}

export function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: 'evt-1',
    locationId: 'loc-lobby',
    cameraId: 'cam-lobby-01',
    peopleCount: 42,
    intervalSeconds: 30,
    observedAt: '2026-05-01T10:00:00.000Z',
    ...overrides,
  };
}

/** Hits the contract path from the brief. */
export async function postIngest(
  url: string,
  body: string | Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return postIngestTo(url, '/api/v1/iot/people-count', body, headers);
}

/** Hits the Day 1 path, which must still work as a compatibility alias. */
export async function postIngestLegacy(
  url: string,
  body: string | Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return postIngestTo(url, '/ingest/people-count', body, headers);
}

async function postIngestTo(
  url: string,
  path: string,
  body: string | Record<string, unknown>,
  headers: Record<string, string>,
): Promise<Response> {
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const intervalMs = options.intervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
}
