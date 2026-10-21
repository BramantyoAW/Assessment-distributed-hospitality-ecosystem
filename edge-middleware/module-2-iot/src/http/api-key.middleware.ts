import type { NextFunction, Request, Response } from 'express';

import { safeEqual } from '../lib/safe-equal.js';

/**
 * Validates the static API key the cameras send as `X-API-Key`.
 *
 * A shared static key is the right trade-off here: cameras are flashed once and
 * are not going to rotate credentials, and the alternative (per-device HMAC with
 * a clock) fails on devices whose clocks drift. Documented in the README as a
 * limitation with a rotation story.
 */
export function createApiKeyMiddleware(expectedKey: string) {
  return function requireApiKey(req: Request, res: Response, next: NextFunction): void {
    if (!safeEqual(req.get('x-api-key'), expectedKey)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    next();
  };
}
