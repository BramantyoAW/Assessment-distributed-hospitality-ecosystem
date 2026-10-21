import type { NextFunction, Request, Response } from 'express';

import { safeEqual } from '../lib/safe-equal.js';

/**
 * Validates the `Authorization: Bearer <token>` header Opera PMS sends.
 *
 * The token is compared through `safeEqual`, which handles differing lengths
 * before delegating to `crypto.timingSafeEqual`. A malformed credential must
 * produce 401, never 500.
 */
export function createBearerTokenMiddleware(expectedToken: string) {
  return function requireBearerToken(req: Request, res: Response, next: NextFunction): void {
    const header = req.get('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);

    if (!match || !safeEqual(match[1], expectedToken)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    next();
  };
}
