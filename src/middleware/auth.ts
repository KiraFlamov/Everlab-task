import crypto from 'node:crypto';
import type { RequestHandler } from 'express';
import { AppError } from '../errors';

export type AccessLevel = 'full' | 'readonly';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const digest = (value: string) => crypto.createHash('sha256').update(value).digest();

/**
 * Bearer token (API key) authentication with two access levels:
 * the full key may call everything, the read-only key may only call safe (GET) methods.
 */
export function authenticate(keys: { full: string; readonly: string | null }): RequestHandler {
  // Comparing fixed-size digests with timingSafeEqual avoids leaking key contents/length via timing
  const known: Array<{ hash: Buffer; level: AccessLevel }> = [{ hash: digest(keys.full), level: 'full' }];
  if (keys.readonly) known.push({ hash: digest(keys.readonly), level: 'readonly' });

  return (req, res, next) => {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(req.get('authorization') ?? '');
    if (!match) {
      res.set('WWW-Authenticate', 'Bearer');
      return next(new AppError(401, 'UNAUTHORIZED', 'Missing or malformed Authorization header (expected "Bearer <API key>")'));
    }

    const hash = digest(match[1]);
    const entry = known.find((k) => crypto.timingSafeEqual(k.hash, hash));
    if (!entry) {
      res.set('WWW-Authenticate', 'Bearer error="invalid_token"');
      return next(new AppError(401, 'UNAUTHORIZED', 'Invalid API key'));
    }
    if (entry.level === 'readonly' && !READ_METHODS.has(req.method)) {
      return next(new AppError(403, 'FORBIDDEN', 'This API key has read-only access'));
    }
    res.locals.accessLevel = entry.level;
    next();
  };
}
