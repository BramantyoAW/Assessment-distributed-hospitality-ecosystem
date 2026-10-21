import { strict as assert } from 'node:assert';
import { constants, createVerify, generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';

import { buildClientAssertion, createNetSuiteTokenProvider } from '../src/netsuite/auth.js';
import { buildTransactionQuery, createNetSuiteClient } from '../src/netsuite/client.js';
import { mapTransactionRow } from '../src/netsuite/mapping.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const CREDENTIALS = {
  clientId: 'client-abc',
  certificateId: 'cert-123',
  privateKeyPem,
  tokenUrl: 'https://example.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token',
};

function decode(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

test('the client assertion is PS256, carries the kid, and pins the REST scope', () => {
  const assertion = buildClientAssertion(CREDENTIALS, Date.parse('2026-05-01T00:00:00Z'));
  const [headerPart, payloadPart, signaturePart] = assertion.split('.');
  assert.ok(headerPart && payloadPart && signaturePart);

  const header = decode(headerPart);
  assert.equal(header['alg'], 'PS256', 'RS256 is rejected by NetSuite for this flow');
  assert.equal(header['kid'], 'cert-123', 'without kid NetSuite cannot pick a certificate');
  assert.equal(header['typ'], 'JWT');

  const payload = decode(payloadPart);
  assert.equal(payload['iss'], 'client-abc');
  assert.equal(payload['scope'], 'rest_webservices');
  assert.equal(payload['aud'], CREDENTIALS.tokenUrl);
  assert.equal(payload['exp'], Number(payload['iat']) + 3_600);
});

test('the assertion signature verifies with RSASSA-PSS over the signing input', () => {
  const assertion = buildClientAssertion(CREDENTIALS, Date.now());
  const [headerPart, payloadPart, signaturePart] = assertion.split('.');
  assert.ok(headerPart && payloadPart && signaturePart);

  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${headerPart}.${payloadPart}`);
  verifier.end();

  const valid = verifier.verify(
    { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
    Buffer.from(signaturePart, 'base64url'),
  );

  assert.equal(valid, true);
});

test('the token is cached until it is close to expiry', async () => {
  let calls = 0;
  let now = Date.parse('2026-05-01T00:00:00Z');

  const provider = createNetSuiteTokenProvider({
    ...CREDENTIALS,
    now: () => now,
    fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify({ access_token: `token-${calls}`, expires_in: 3_600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal(await provider.getAccessToken(), 'token-1');
  assert.equal(await provider.getAccessToken(), 'token-1');
  assert.equal(calls, 1, 'a valid token must not be re-requested');

  // One minute before expiry is the refresh point, so this invalidates the cache.
  now += 60 * 60 * 1000;
  assert.equal(await provider.getAccessToken(), 'token-2');
  assert.equal(calls, 2);
});

test('a token error surfaces the NetSuite body instead of hiding it', async () => {
  const provider = createNetSuiteTokenProvider({
    ...CREDENTIALS,
    fetch: async () => new Response('{"error":"invalid_grant"}', { status: 400 }),
  });

  await assert.rejects(() => provider.getAccessToken(), /400.*invalid_grant/s);
});

test('the page query is keyset-ordered and day-granular on the cursor', () => {
  const sql = buildTransactionQuery({ sinceIso: '2026-05-01T10:30:00.000Z', limit: 200 });

  assert.match(sql, /lastmodifieddate >= TO_DATE\('2026-05-01'/);
  assert.match(sql, /ORDER BY lastmodifieddate ASC, id ASC/);
  assert.doesNotMatch(sql, /OFFSET/i, 'OFFSET would make a backfill quadratic');
});

test('an injected cursor value never reaches the SQL', () => {
  assert.throws(
    () => buildTransactionQuery({ sinceIso: "2026-05-01T00:00:00Z' OR 1=1 --", limit: 10 }),
    RangeError,
  );
  assert.throws(() => buildTransactionQuery({ sinceIso: '2026-05-01T00:00:00Z', limit: 10_000 }), RangeError);
  assert.throws(() => buildTransactionQuery({ sinceIso: '2026-05-01T00:00:00Z', limit: 0 }), RangeError);
});

test('a page request carries the bearer token, the SQL and the transient preference', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const client = createNetSuiteClient({
    baseUrl: 'https://example.suitetalk.api.netsuite.com/',
    tokenProvider: { getAccessToken: async () => 'token-1' },
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ items: [{ id: '1', lastmodifieddate: '2026-05-01T10:00:00Z' }], hasMore: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const page = await client.fetchTransactionPage({ sinceIso: '2026-05-01T00:00:00Z', limit: 200 });

  assert.equal(page.rows.length, 1);
  assert.equal(page.hasMore, true);

  const request = requests[0];
  assert.ok(request);
  assert.equal(request.url, 'https://example.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql?limit=200');

  const headers = request.init.headers as Record<string, string>;
  assert.equal(headers['Authorization'], 'Bearer token-1');
  assert.equal(headers['Prefer'], 'transient');

  const body = JSON.parse(String(request.init.body)) as { q: string };
  assert.match(body.q, /FROM transaction/);
});

test('a full SuiteQL row maps to a fact, with no timezone conversion of trandate', () => {
  const result = mapTransactionRow(
    {
      id: '1042',
      trandate: '2026-04-30',
      amount: '250000.00',
      currency: 'IDR',
      type: 'Cash Sale',
      location: '2',
      guests: 4,
      createddate: '2026-04-30T09:00:00Z',
      lastmodifieddate: '2026-05-01T02:00:00Z',
    },
    {
      ingestedAt: '2026-05-01T03:00:00.000Z',
      resolveLocationId: (raw) => (String(raw) === '2' ? 'loc-pool' : null),
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.fact.transactionId, '1042');
  assert.equal(result.fact.locationId, 'loc-pool');
  assert.equal(result.fact.businessDate, '2026-04-30', 'trandate is already the business date');
  assert.equal(result.fact.amount, '250000.00');
  assert.equal(result.fact.txnType, 'fnb');
  assert.equal(result.fact.guests, 4);
  assert.equal(result.fact.occurredAt, null);
  assert.equal(result.fact.occurredAtSource, 'unavailable', 'a date is not a timestamp');
});

test('a full timestamp in trandate is used and marked as coming from the record', () => {
  const result = mapTransactionRow(
    { id: '7', trandate: '2026-04-30T20:15:00Z', amount: '10.00', location: '1', lastmodifieddate: '2026-05-01T01:00:00Z' },
    { ingestedAt: '2026-05-01T00:00:00.000Z', resolveLocationId: () => 'loc-lobby' },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.fact.occurredAt, '2026-04-30T20:15:00.000Z');
  assert.equal(result.fact.occurredAtSource, 'record');
});

test('unmappable rows are rejected with a reason instead of coerced', () => {
  const context = {
    ingestedAt: '2026-05-01T00:00:00.000Z',
    resolveLocationId: (raw: unknown) => (String(raw) === '2' ? 'loc-pool' : null),
  };

  const cases: { row: Record<string, unknown>; reason: string }[] = [
    { row: { trandate: '2026-04-30', amount: '1.00', location: '2' }, reason: 'missing_id' },
    { row: { id: '1', trandate: '2026-02-31', amount: '1.00', location: '2' }, reason: 'invalid_trandate' },
    { row: { id: '1', trandate: '2026-04-30', amount: 'abc', location: '2' }, reason: 'invalid_amount' },
    { row: { id: '1', trandate: '2026-04-30', amount: '1.00', location: '2' }, reason: 'invalid_lastmodifieddate' },
    {
      row: { id: '1', trandate: '2026-04-30', amount: '1.00', location: '99', lastmodifieddate: '2026-05-01T00:00:00Z' },
      reason: 'unknown_location',
    },
  ];

  for (const { row, reason } of cases) {
    const result = mapTransactionRow(row, context);
    assert.equal(result.ok, false, `${reason} must reject`);
    if (!result.ok) assert.equal(result.reason, reason);
  }
});

test('a missing guests count stays null, and a zero is preserved as zero', () => {
  const context = {
    ingestedAt: '2026-05-01T00:00:00.000Z',
    resolveLocationId: () => 'loc-pool',
  };
  const base = { id: '1', trandate: '2026-04-30', amount: '1.00', lastmodifieddate: '2026-05-01T00:00:00Z' };

  const missing = mapTransactionRow(base, context);
  assert.equal(missing.ok, true);
  if (missing.ok) assert.equal(missing.fact.guests, null);

  const zero = mapTransactionRow({ ...base, guests: 0 }, context);
  assert.equal(zero.ok, true);
  if (zero.ok) assert.equal(zero.fact.guests, 0);
});
