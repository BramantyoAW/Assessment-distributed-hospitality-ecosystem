/**
 * NetSuite OAuth 2.0 machine-to-machine authentication.
 *
 * Three details are load-bearing and were each a review finding:
 *
 * 1. `PS256`, not `RS256`. NetSuite's certificate-based client credentials flow
 *    requires RSASSA-PSS with SHA-256. An RS256 token is rejected, and the error
 *    ("invalid_client") says nothing about the algorithm.
 *
 * 2. `kid` is the certificate id, and it is mandatory. Without it NetSuite cannot
 *    pick which uploaded certificate should verify the signature.
 *
 * 3. `scope=rest_webservices` must be in the assertion, not only on the token
 *    request. Without it the token is issued with no REST scope and every call
 *    returns 403.
 *
 * No private key is bundled and no key is read from disk by default: the PEM comes
 * from the environment, which in Cloud Run means a Secret Manager reference.
 */

import { constants, createSign, randomUUID } from 'node:crypto';

const DEFAULT_SCOPE = 'rest_webservices';
const ASSERTION_TTL_SECONDS = 3_600;

export interface NetSuiteCredentials {
  readonly clientId: string;
  /** The certificate id NetSuite shows after uploading the public key. */
  readonly certificateId: string;
  readonly privateKeyPem: string;
  readonly tokenUrl: string;
  readonly scope?: string;
}

export interface TokenProvider {
  getAccessToken(): Promise<string>;
}

export interface TokenProviderOptions extends NetSuiteCredentials {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

interface CachedToken {
  readonly value: string;
  /** Epoch milliseconds after which the token must not be reused. */
  readonly refreshAt: number;
}

export function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** Exported so a test can decode and verify the exact assertion NetSuite sees. */
export function buildClientAssertion(
  credentials: NetSuiteCredentials,
  now: number = Date.now(),
): string {
  const issuedAt = Math.floor(now / 1000);

  const header = { alg: 'PS256', typ: 'JWT', kid: credentials.certificateId };
  const payload = {
    iss: credentials.clientId,
    scope: credentials.scope ?? DEFAULT_SCOPE,
    aud: credentials.tokenUrl,
    iat: issuedAt,
    exp: issuedAt + ASSERTION_TTL_SECONDS,
    jti: randomUUID(),
  };

  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);

  const signature = signer.sign({
    key: credentials.privateKeyPem,
    // PSS is what makes this PS256 rather than RS256: salt length equal to the
    // digest length is the JWA requirement.
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  });

  return `${signingInput}.${Buffer.from(signature).toString('base64url')}`;
}

export function createNetSuiteTokenProvider(options: TokenProviderOptions): TokenProvider {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let cached: CachedToken | undefined;

  return {
    async getAccessToken(): Promise<string> {
      const current = now();
      if (cached !== undefined && cached.refreshAt > current) {
        return cached.value;
      }

      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: buildClientAssertion(options, current),
      });

      const response = await fetchImpl(options.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      if (!response.ok) {
        // Body included on purpose: NetSuite's error names the missing scope or the
        // wrong certificate, and hiding it turns a 30-second fix into an afternoon.
        const detail = await response.text();
        throw new Error(
          `netsuite token request failed: ${response.status} ${detail.slice(0, 300)}`,
        );
      }

      const payload = (await response.json()) as {
        access_token?: unknown;
        expires_in?: unknown;
      };
      if (typeof payload.access_token !== 'string' || payload.access_token === '') {
        throw new Error('netsuite token response contained no access_token');
      }

      const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 3_600;
      cached = {
        value: payload.access_token,
        // Refresh a minute early: a token that expires mid-request is a 401 that
        // looks like a permission problem.
        refreshAt: current + Math.max(0, expiresIn - 60) * 1_000,
      };

      return cached.value;
    },
  };
}
