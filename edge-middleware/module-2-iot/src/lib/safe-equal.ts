import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison that is safe against variable-length input.
 *
 * `crypto.timingSafeEqual` THROWS when the two buffers differ in length, which
 * would turn a malformed API key into a 500 instead of a 401. The length check
 * leaks only the length of the secret, and the content comparison stays
 * constant-time.
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
