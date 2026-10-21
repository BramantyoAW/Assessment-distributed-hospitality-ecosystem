import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison that is safe against variable-length input.
 *
 * `crypto.timingSafeEqual` THROWS when the two buffers differ in length
 * (`ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`). Calling it directly with a value
 * taken from a request turns a malformed credential into a 500 instead of a 401.
 *
 * Comparing the lengths first does not weaken the guarantee: the length of a
 * token is not a secret, only its content is, and the content comparison stays
 * constant-time.
 *
 * Used by three call sites: Opera bearer token, IoT API key, HMAC signature
 * verification in the mock NetSuite.
 */
export function safeEqual(received: string | undefined | null, expected: string): boolean {
  if (typeof received !== 'string') return false;

  // An empty configured secret must never mean "accept everything".
  if (expected.length === 0) return false;

  const receivedBuffer = Buffer.from(received, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');

  if (receivedBuffer.length !== expectedBuffer.length) return false;

  return timingSafeEqual(receivedBuffer, expectedBuffer);
}
