import type { OperaConfig } from '../config.js';
import {
  HEADER_IDEMPOTENCY,
  HEADER_KEY_ID,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  currentTimestampSeconds,
  signRequest,
} from './signer.js';

/**
 * Outbound NetSuite client.
 *
 * `fetch` is injected so tests can exercise every outcome without a network or
 * a mocking library. The body is sent as the exact Buffer that was received on
 * the webhook, never re-serialised.
 */

export type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

export interface SendOutcome {
  readonly ok: boolean;
  readonly status: number;
  readonly retryable: boolean;
  readonly error?: string;
}

export interface NetsuiteClient {
  send(eventId: string, payload: Buffer): Promise<SendOutcome>;
}

/** Status codes that are worth retrying even though they are 4xx. */
const RETRYABLE_4XX = new Set([408, 425, 429]);

export function createNetsuiteClient(
  config: OperaConfig,
  fetchImpl: FetchImpl = globalThis.fetch,
): NetsuiteClient {
  const url = new URL(config.netsuiteUrl);
  const path = `${url.pathname}${url.search}`;

  return {
    async send(eventId, payload): Promise<SendOutcome> {
      const timestamp = currentTimestampSeconds();
      const signature = signRequest(
        { method: 'POST', path, timestamp, body: payload },
        config.hmacSecret,
      );

      let response: Response;
      try {
        response = await fetchImpl(config.netsuiteUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [HEADER_SIGNATURE]: signature,
            [HEADER_TIMESTAMP]: timestamp,
            [HEADER_KEY_ID]: config.keyId,
            [HEADER_IDEMPOTENCY]: eventId,
          },
          body: payload,
          signal: AbortSignal.timeout(config.netsuiteTimeoutMs),
        });
      } catch (error) {
        // Timeouts, connection refused, DNS failures: always worth retrying.
        return { ok: false, status: 0, retryable: true, error: `network: ${describe(error)}` };
      }

      if (response.ok) {
        // Drain the body so the socket is released.
        await response.arrayBuffer().catch(() => undefined);
        return { ok: true, status: response.status, retryable: false };
      }

      const retryable = response.status >= 500 || RETRYABLE_4XX.has(response.status);
      const detail = await response.text().catch(() => '');
      const suffix = detail === '' ? '' : `: ${detail.slice(0, 200)}`;
      return {
        ok: false,
        status: response.status,
        retryable,
        error: `HTTP ${response.status}${suffix}`,
      };
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
