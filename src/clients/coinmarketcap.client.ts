import axios, { AxiosError, type AxiosInstance } from 'axios';
import { ExternalApiError } from '../errors';
import { silentLogger, type Logger } from '../utils/logger';

export interface CoinInfo {
  cmcId: number;
  symbol: string;
  name: string;
}

export interface Quote {
  cmcId: number;
  price: number;
  lastUpdated: string | null;
}

/** Abstraction used by services; allows replacing the real client in tests. */
export interface PriceProvider {
  findBySymbol(symbol: string, signal?: AbortSignal): Promise<CoinInfo | null>;
  getQuotes(cmcIds: number[], currency: string, signal?: AbortSignal): Promise<Map<number, Quote>>;
}

export interface CoinMarketCapClientOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  logger?: Logger;
}

interface CmcStatus {
  error_code?: number;
  error_message?: string | null;
}

interface CmcMapItem {
  id: number;
  name: string;
  symbol: string;
  rank?: number | null;
  is_active?: number;
}

interface CmcQuoteItem {
  id: number;
  quote?: Record<string, { price?: number | null; last_updated?: string | null }>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const MAX_IDS_PER_REQUEST = 100;

/** Client for the official CoinMarketCap Pro API (https://coinmarketcap.com/api/documentation/v1/). */
export class CoinMarketCapClient implements PriceProvider {
  private readonly http: AxiosInstance;
  private readonly logger: Logger;

  constructor(private readonly options: CoinMarketCapClientOptions) {
    this.logger = options.logger ?? silentLogger;
    this.http = axios.create({
      baseURL: options.baseUrl,
      timeout: options.timeoutMs,
      headers: { 'X-CMC_PRO_API_KEY': options.apiKey, Accept: 'application/json' },
      // Every status is inspected manually to produce meaningful errors
      validateStatus: () => true,
    });
  }

  async findBySymbol(symbol: string, signal?: AbortSignal): Promise<CoinInfo | null> {
    let data: unknown;
    try {
      data = await this.request('/v1/cryptocurrency/map', { symbol }, signal);
    } catch (error) {
      // CMC answers 400 "Invalid value for symbol" when nothing matches
      if (error instanceof ExternalApiError && error.kind === 'BAD_REQUEST' && /symbol/i.test(error.message)) {
        return null;
      }
      throw error;
    }
    if (!Array.isArray(data)) throw new ExternalApiError('INVALID_RESPONSE', 'Unexpected CoinMarketCap response format');

    const candidates = (data as CmcMapItem[]).filter(
      (item) => isObject(item) && Number.isInteger(item.id) && typeof item.name === 'string' && item.is_active !== 0,
    );
    if (candidates.length === 0) return null;
    // Several coins may share a symbol: pick the highest ranked one
    candidates.sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER));
    const best = candidates[0];
    return { cmcId: best.id, symbol: best.symbol.toUpperCase(), name: best.name };
  }

  async getQuotes(cmcIds: number[], currency: string, signal?: AbortSignal): Promise<Map<number, Quote>> {
    const result = new Map<number, Quote>();
    for (let i = 0; i < cmcIds.length; i += MAX_IDS_PER_REQUEST) {
      const chunk = cmcIds.slice(i, i + MAX_IDS_PER_REQUEST);
      const data = await this.request(
        '/v2/cryptocurrency/quotes/latest',
        { id: chunk.join(','), convert: currency, skip_invalid: true },
        signal,
      );
      if (!isObject(data)) throw new ExternalApiError('INVALID_RESPONSE', 'Unexpected CoinMarketCap response format');

      for (const item of Object.values(data) as CmcQuoteItem[]) {
        if (!isObject(item) || !Number.isInteger(item.id)) continue;
        const quote = isObject(item.quote) ? item.quote[currency] : undefined;
        const price = quote?.price;
        if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) {
          this.logger.warn('CoinMarketCap returned no valid price', { cmcId: item.id });
          continue;
        }
        result.set(item.id, { cmcId: item.id, price, lastUpdated: quote?.last_updated ?? null });
      }
    }
    return result;
  }

  /** Performs a GET request with retries for transient failures. Returns the `data` field of the payload. */
  private async request(url: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const { maxRetries, retryBaseDelayMs } = this.options;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.requestOnce(url, params, signal);
      } catch (error) {
        const apiError = error as ExternalApiError;
        if (!apiError.retryable || attempt >= maxRetries || signal?.aborted) throw apiError;
        const delay = retryBaseDelayMs * 2 ** attempt;
        this.logger.warn('CoinMarketCap request failed, retrying', {
          url,
          attempt: attempt + 1,
          kind: apiError.kind,
          delayMs: delay,
        });
        await sleep(delay, signal);
      }
    }
  }

  private async requestOnce(url: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    let response;
    try {
      response = await this.http.get(url, { params, signal });
    } catch (error) {
      throw toTransportError(error);
    }

    const body: unknown = response.data;
    const status = isObject(body) && isObject(body.status) ? (body.status as CmcStatus) : undefined;
    const upstreamMessage = typeof status?.error_message === 'string' ? status.error_message : undefined;

    if (response.status === 429) {
      throw new ExternalApiError('RATE_LIMITED', 'CoinMarketCap rate limit exceeded', 429);
    }
    if (response.status === 401 || response.status === 402 || response.status === 403) {
      throw new ExternalApiError(
        'UNAUTHORIZED',
        'CoinMarketCap rejected the API key or the plan does not allow this request',
        response.status,
      );
    }
    if (response.status >= 500) {
      throw new ExternalApiError('UPSTREAM_ERROR', `CoinMarketCap responded with ${response.status}`, response.status);
    }
    if (response.status >= 400) {
      throw new ExternalApiError(
        'BAD_REQUEST',
        `CoinMarketCap rejected the request${upstreamMessage ? `: ${upstreamMessage}` : ''}`,
        response.status,
      );
    }
    if (!isObject(body) || !('data' in body)) {
      throw new ExternalApiError('INVALID_RESPONSE', 'Unexpected CoinMarketCap response format', response.status);
    }
    if (status?.error_code && status.error_code !== 0) {
      throw new ExternalApiError(
        'UPSTREAM_ERROR',
        `CoinMarketCap returned error ${status.error_code}${upstreamMessage ? `: ${upstreamMessage}` : ''}`,
        response.status,
      );
    }
    return body.data;
  }
}

// Raw axios errors carry the request config (including the API key header) and must never leak
function toTransportError(error: unknown): ExternalApiError {
  if (axios.isCancel(error) || (error instanceof AxiosError && error.code === AxiosError.ERR_CANCELED)) {
    return new ExternalApiError('ABORTED', 'CoinMarketCap request was aborted');
  }
  if (error instanceof AxiosError && (error.code === AxiosError.ECONNABORTED || error.code === AxiosError.ETIMEDOUT)) {
    return new ExternalApiError('TIMEOUT', 'CoinMarketCap request timed out');
  }
  return new ExternalApiError('NETWORK', 'CoinMarketCap is unreachable');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ExternalApiError('ABORTED', 'CoinMarketCap request was aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ExternalApiError('ABORTED', 'CoinMarketCap request was aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
