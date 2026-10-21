import { createHash, createHmac } from 'node:crypto';

import { safeEqual } from '../lib/safe-equal.js';

/**
 * HMAC-SHA256 signing for the Edge middleware -> NetSuite hop.
 *
 * Canonical string (newline separated, so no field can contain an ambiguous
 * boundary):
 *
 *     METHOD \n PATH \n TIMESTAMP \n SHA256_HEX(BODY)
 *
 * The body is hashed rather than inlined because JSON contains newlines of its
 * own; a hash keeps the canonical string fixed-length and unambiguous.
 * The timestamp is inside the signature so a leaked signature cannot be
 * replayed after the allowed skew window.
 */

export const HEADER_SIGNATURE = 'x-signature';
export const HEADER_TIMESTAMP = 'x-timestamp';
export const HEADER_KEY_ID = 'x-key-id';
export const HEADER_IDEMPOTENCY = 'idempotency-key';

/** Version prefix allows a future algorithm change without breaking old senders. */
export const SIGNATURE_VERSION = 'v1';

export const DEFAULT_CLOCK_SKEW_SECONDS = 300;

export interface SignableRequest {
  readonly method: string;
  readonly path: string;
  /** Unix seconds, as a string. */
  readonly timestamp: string;
  readonly body: Uint8Array;
}

export function sha256Hex(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

export function buildCanonicalString(request: SignableRequest): string {
  return [
    request.method.toUpperCase(),
    request.path,
    request.timestamp,
    sha256Hex(request.body),
  ].join('\n');
}

export function signCanonical(canonical: string, secret: string): string {
  const digest = createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
  return `${SIGNATURE_VERSION}=${digest}`;
}

export function signRequest(request: SignableRequest, secret: string): string {
  return signCanonical(buildCanonicalString(request), secret);
}

export function verifySignature(
  receivedSignature: string | undefined,
  canonical: string,
  secret: string,
): boolean {
  if (typeof receivedSignature !== 'string') return false;
  return safeEqual(receivedSignature, signCanonical(canonical, secret));
}

export function currentTimestampSeconds(now: number = Date.now()): string {
  return String(Math.floor(now / 1000));
}

/** Rejects replay attempts outside the allowed clock skew. */
export function isTimestampFresh(
  timestamp: string,
  nowSeconds: number,
  skewSeconds: number = DEFAULT_CLOCK_SKEW_SECONDS,
): boolean {
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  return Math.abs(nowSeconds - Number(timestamp)) <= skewSeconds;
}
