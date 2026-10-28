export interface ErrorDetail {
  field?: string;
  message: string;
}

/** Error that is safe to expose to API clients. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(details: ErrorDetail[]) {
    super(400, 'VALIDATION_ERROR', 'Request validation failed', details);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(404, 'NOT_FOUND', message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, 'CONFLICT', message);
  }
}

export type ExternalErrorKind =
  | 'TIMEOUT'
  | 'NETWORK'
  | 'RATE_LIMITED'
  | 'UPSTREAM_ERROR'
  | 'UNAUTHORIZED'
  | 'BAD_REQUEST'
  | 'INVALID_RESPONSE'
  | 'ABORTED';

const RETRYABLE: ReadonlySet<ExternalErrorKind> = new Set(['TIMEOUT', 'NETWORK', 'RATE_LIMITED', 'UPSTREAM_ERROR']);

/**
 * Failure of the CoinMarketCap API. The message never contains the API key or raw upstream
 * payloads, so it can be returned to clients as is.
 */
export class ExternalApiError extends AppError {
  constructor(
    public readonly kind: ExternalErrorKind,
    message: string,
    public readonly upstreamStatus?: number,
  ) {
    // Temporary unavailability -> 503; misconfiguration / unexpected payload -> 502
    super(RETRYABLE.has(kind) || kind === 'ABORTED' ? 503 : 502, `EXTERNAL_API_${kind}`, message);
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }
}
