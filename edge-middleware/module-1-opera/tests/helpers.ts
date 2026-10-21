import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import type { Express } from 'express';

import { createApp } from '../src/app.js';
import type { OperaConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import type { Logger } from '../src/logger.js';
import { OperaEventsRepo } from '../src/queue/events.repo.js';

export interface TestServer {
  readonly url: string;
  close(): Promise<void>;
}

export function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dhe-module-1-'));
}

export function tempDbPath(): string {
  return join(makeTempDir(), 'opera-queue.db');
}

export function createTestConfig(overrides: Partial<OperaConfig> = {}): OperaConfig {
  return {
    port: 0,
    bearerToken: 'test-bearer-token',
    netsuiteUrl: 'http://127.0.0.1:1/api/v1/opera/events',
    hmacSecret: 'test-hmac-secret',
    keyId: 'test-key',
    dbPath: ':memory:',
    pollIntervalMs: 10,
    retryBaseMs: 0,
    retryMaxDelayMs: 0,
    maxAttempts: 3,
    shutdownGraceMs: 200,
    bodyLimit: '64kb',
    netsuiteTimeoutMs: 500,
    ...overrides,
  };
}

/** Logger that swallows output so test reports stay readable. */
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

export interface Harness {
  readonly url: string;
  readonly repo: OperaEventsRepo;
  readonly config: OperaConfig;
  close(): Promise<void>;
}

export async function startHarness(overrides: Partial<OperaConfig> = {}): Promise<Harness> {
  const config = createTestConfig(overrides);
  const repo = new OperaEventsRepo(config.dbPath, { maxAttempts: config.maxAttempts });
  const app = createApp({ config, repo, logger: silentLogger() });
  const server = await listen(app);

  return {
    url: server.url,
    repo,
    config,
    async close(): Promise<void> {
      await server.close();
      repo.close();
    },
  };
}

export const BEARER = 'test-bearer-token';

export async function postWebhook(
  url: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${url}/webhook/opera`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${BEARER}`,
      ...headers,
    },
    body,
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
