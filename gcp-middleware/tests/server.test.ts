import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import { createMemoryGateway } from '../src/bigquery/memory.gateway.js';
import { createLogger } from '../src/logger.js';
import { createServer } from '../src/server.js';

const DATE = '2026-05-01';

interface TestServer {
  readonly url: string;
  close(): Promise<void>;
}

async function listen(): Promise<TestServer> {
  const app = createServer({
    gateway: createMemoryGateway(),
    logger: createLogger({ service: 'test', sink: () => {} }),
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => {
      resolve();
    });
    server.once('error', reject);
  });

  const address = server.address() as AddressInfo | null;
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP address');
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

async function post(
  server: TestServer,
  path: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('POST /graphql answers a query', async () => {
  const server = await listen();
  try {
    const response = await post(server, '/graphql', {
      query: `{ locations { id name } }`,
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: { locations: { id: string }[] } };
    assert.equal(body.data.locations.length, 4);
  } finally {
    await server.close();
  }
});

test('POST /graphql accepts variables', async () => {
  const server = await listen();
  try {
    const response = await post(server, '/graphql', {
      query: `query One($id: ID!) { location(id: $id) { name } }`,
      variables: { id: 'loc-pool' },
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: { location: { name: string } } };
    assert.equal(body.data.location.name, 'Main Pool');
  } finally {
    await server.close();
  }
});

test('GET /graphql is refused: no playground on an IAM-only service', async () => {
  const server = await listen();
  try {
    const response = await fetch(`${server.url}/graphql`);
    assert.equal(response.status, 405);
  } finally {
    await server.close();
  }
});

test('GET /healthz reports liveness', async () => {
  const server = await listen();
  try {
    const response = await fetch(`${server.url}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  } finally {
    await server.close();
  }
});

test('there is no ingest route on the service', async () => {
  const server = await listen();
  try {
    for (const path of ['/internal/ingest', '/ingest', '/api/v1/ingest']) {
      const response = await post(server, path, {});
      assert.equal(response.status, 404, `${path} must not exist`);
    }
  } finally {
    await server.close();
  }
});

test('a missing query is a 400 with a message, not a 500', async () => {
  const server = await listen();
  try {
    const response = await post(server, '/graphql', { variables: {} });
    assert.equal(response.status, 400);
  } finally {
    await server.close();
  }
});

test('malformed JSON is a 400, not a crash', async () => {
  const server = await listen();
  try {
    const response = await post(server, '/graphql', '{not json');
    assert.equal(response.status, 400);
  } finally {
    await server.close();
  }
});

test('a too-deep query is refused with 400 before execution', async () => {
  const server = await listen();
  try {
    const response = await post(server, '/graphql', {
      query: `{ location(id: "x") { conversionRate(date: "${DATE}") { location { conversionRate(date: "${DATE}") { location { conversionRate(date: "${DATE}") { location { name } } } } } } } }`,
    });

    assert.equal(response.status, 400);
    const body = (await response.json()) as { errors: { message: string }[] };
    assert.match(body.errors[0]?.message ?? '', /maximum is/);
  } finally {
    await server.close();
  }
});

test('an invalid field is reported by validation, and no data is returned', async () => {
  const server = await listen();
  try {
    const response = await post(server, '/graphql', { query: '{ nope }' });

    assert.equal(response.status, 400);
    const body = (await response.json()) as { errors: { message: string }[] };
    assert.match(body.errors[0]?.message ?? '', /nope/);
  } finally {
    await server.close();
  }
});
