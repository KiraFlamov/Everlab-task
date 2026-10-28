import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, ExternalApiError } from '../errors';
import type { Logger } from '../utils/logger';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`));
};

interface HttpError extends Error {
  status?: number;
  type?: string;
}

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, req, res, _next) => {
    let error: AppError;
    if (err instanceof AppError) {
      error = err;
    } else if ((err as HttpError)?.type === 'entity.parse.failed') {
      error = new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON');
    } else if ((err as HttpError)?.type === 'entity.too.large') {
      error = new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    } else if ((err as HttpError)?.type === 'encoding.unsupported' || (err as HttpError)?.type === 'charset.unsupported') {
      error = new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported request body encoding');
    } else {
      // Unexpected errors are logged with details but returned to the client without internals
      logger.error('Unhandled error', {
        method: req.method,
        path: req.path,
        error: err instanceof Error ? err.stack : String(err),
      });
      error = new AppError(500, 'INTERNAL_ERROR', 'Internal server error');
    }

    if (error instanceof ExternalApiError) {
      logger.warn('External API error', { path: req.path, code: error.code, upstreamStatus: error.upstreamStatus });
      if (error.status === 503) res.set('Retry-After', '30');
    }

    res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    });
  };
}
