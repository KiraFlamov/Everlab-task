import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CoinMarketCapClient, type CoinMarketCapClientOptions } from '../src/clients/coinmarketcap.client';
import { ExternalApiError } from '../src/errors';

const CMC_KEY = 'secret-cmc-key';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/** Local HTTP server imitating CoinMarketCap; responses are scripted per test. */
class FakeCmcServer {
  private server = http.createServer((req, res) => {
    this.requests.push({ url: req.url ?? '', apiKey: req.headers['x-cmc_pro_api_key'] });
    const handler = this.handlers.shift() ?? this.fallback;
    handler(req, res);
  });
  requests: Array<{ url: string; apiKey: string | string[] | undefined }> = [];
  handlers: Handler[] = [];
  fallback: Handler = (_req, res) => json(res, 500, {});
  baseUrl = '';

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const ok = (data: unknown): Handler => (_req, res) =>
  json(res, 200, { status: { error_code: 0, error_message: null }, data });

const quotes = (prices: Record<number, number | null>) =>
  Object.fromEntries(
    Object.entries(prices).map(([id, price]) => [
      id,
      { id: Number(id), quote: { USD: { price, last_updated: '2024-05-01T10:00:00.000Z' } } },
    ]),
  );

async function expectExternalError(promise: Promise<unknown>, kind: string): Promise<ExternalApiError> {
  const error = await promise.then(
    () => {
      throw new Error('Expected promise to reject');
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ExternalApiError);
  expect((error as ExternalApiError).kind).toBe(kind);
  // The CoinMarketCap key must never end up in errors that may reach clients or logs
  expect(JSON.stringify(error)).not.toContain(CMC_KEY);
  expect((error as Error).message).not.toContain(CMC_KEY);
  return error as ExternalApiError;
}

describe('CoinMarketCapClient', () => {
  const server = new FakeCmcServer();
  let client: CoinMarketCapClient;

  const createClient = (overrides: Partial<CoinMarketCapClientOptions> = {}) =>
    new CoinMarketCapClient({
      apiKey: CMC_KEY,
      baseUrl: server.baseUrl,
      timeoutMs: 200,
      maxRetries: 0,
      retryBaseDelayMs: 1,
      ...overrides,
    });

  beforeAll(() => server.start());
  afterAll(() => server.stop());

  beforeEach(() => {
    server.requests = [];
    server.handlers = [];
    client = createClient();
  });

  describe('getQuotes', () => {
    it('requests quotes by id in the configured currency and sends the API key header', async () => {
      server.handlers.push(ok(quotes({ 1: 65_000.5, 1027: 3_100 })));

      const result = await client.getQuotes([1, 1027], 'USD');

      expect(result.get(1)).toEqual({ cmcId: 1, price: 65_000.5, lastUpdated: '2024-05-01T10:00:00.000Z' });
      expect(result.get(1027)?.price).toBe(3_100);
      const url = new URL(server.requests[0].url, server.baseUrl);
      expect(url.pathname).toBe('/v2/cryptocurrency/quotes/latest');
      expect(url.searchParams.get('id')).toBe('1,1027');
      expect(url.searchParams.get('convert')).toBe('USD');
      expect(server.requests[0].apiKey).toBe(CMC_KEY);
    });

    it('skips coins without a valid price', async () => {
      server.handlers.push(ok({ ...quotes({ 1: null, 2: -5 }), 3: { id: 3 }, 4: 'garbage' }));

      const result = await client.getQuotes([1, 2, 3, 4], 'USD');

      expect(result.size).toBe(0);
    });

    it('splits large id lists into several requests', async () => {
      const ids = Array.from({ length: 150 }, (_, i) => i + 1);
      server.handlers.push(ok(quotes({ 1: 1 })), ok(quotes({ 150: 150 })));

      const result = await client.getQuotes(ids, 'USD');

      expect(server.requests).toHaveLength(2);
      expect([...result.keys()]).toEqual([1, 150]);
    });

    it('fails with TIMEOUT when CoinMarketCap does not answer in time', async () => {
      server.handlers.push(() => undefined); // never responds

      await expectExternalError(client.getQuotes([1], 'USD'), 'TIMEOUT');
    });

    it('fails with NETWORK when CoinMarketCap is unreachable', async () => {
      const unreachable = createClient({ baseUrl: 'http://127.0.0.1:1' });

      await expectExternalError(unreachable.getQuotes([1], 'USD'), 'NETWORK');
    });

    it('fails with UPSTREAM_ERROR on 5xx responses', async () => {
      server.handlers.push((_req, res) => json(res, 503, {}));

      const error = await expectExternalError(client.getQuotes([1], 'USD'), 'UPSTREAM_ERROR');
      expect(error.status).toBe(503);
      expect(error.upstreamStatus).toBe(503);
    });

    it('fails with RATE_LIMITED on 429', async () => {
      server.handlers.push((_req, res) =>
        json(res, 429, { status: { error_code: 1008, error_message: "You've exceeded your API Key's HTTP request rate limit." } }),
      );

      await expectExternalError(client.getQuotes([1], 'USD'), 'RATE_LIMITED');
    });

    it.each([401, 402, 403])('fails with UNAUTHORIZED (502) on %i', async (status) => {
      server.handlers.push((_req, res) =>
        json(res, status, { status: { error_code: 1001, error_message: 'This API Key is invalid.' } }),
      );

      const error = await expectExternalError(client.getQuotes([1], 'USD'), 'UNAUTHORIZED');
      expect(error.status).toBe(502);
    });

    it('fails with INVALID_RESPONSE when the body is not the expected JSON', async () => {
      server.handlers.push((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html>maintenance</html>');
      });

      await expectExternalError(client.getQuotes([1], 'USD'), 'INVALID_RESPONSE');
    });

    it('fails with UPSTREAM_ERROR when the status block reports an error', async () => {
      server.handlers.push((_req, res) =>
        json(res, 200, { status: { error_code: 500, error_message: 'Internal' }, data: {} }),
      );

      await expectExternalError(client.getQuotes([1], 'USD'), 'UPSTREAM_ERROR');
    });

    it('retries transient failures with backoff and then succeeds', async () => {
      const retrying = createClient({ maxRetries: 2 });
      server.handlers.push(
        (_req, res) => json(res, 502, {}),
        () => undefined, // timeout
        ok(quotes({ 1: 70_000 })),
      );

      const result = await retrying.getQuotes([1], 'USD');

      expect(result.get(1)?.price).toBe(70_000);
      expect(server.requests).toHaveLength(3);
    });

    it('gives up after the configured number of retries', async () => {
      const retrying = createClient({ maxRetries: 1 });
      server.handlers.push((_req, res) => json(res, 500, {}), (_req, res) => json(res, 500, {}));

      await expectExternalError(retrying.getQuotes([1], 'USD'), 'UPSTREAM_ERROR');
      expect(server.requests).toHaveLength(2);
    });

    it('does not retry non-transient errors', async () => {
      const retrying = createClient({ maxRetries: 3 });
      server.handlers.push((_req, res) => json(res, 401, {}));

      await expectExternalError(retrying.getQuotes([1], 'USD'), 'UNAUTHORIZED');
      expect(server.requests).toHaveLength(1);
    });

    it('can be aborted while waiting for a response', async () => {
      const slow = createClient({ timeoutMs: 5_000 });
      server.handlers.push(() => undefined);
      const controller = new AbortController();

      const promise = slow.getQuotes([1], 'USD', controller.signal);
      setTimeout(() => controller.abort(), 20);

      const error = await expectExternalError(promise, 'ABORTED');
      expect(error.retryable).toBe(false);
    });

    it('can be aborted during the retry backoff', async () => {
      const retrying = createClient({ maxRetries: 3, retryBaseDelayMs: 10_000 });
      server.handlers.push((_req, res) => json(res, 500, {}));
      const controller = new AbortController();

      const promise = retrying.getQuotes([1], 'USD', controller.signal);
      setTimeout(() => controller.abort(), 50);

      await expectExternalError(promise, 'ABORTED');
      expect(server.requests).toHaveLength(1);
    });
  });

  describe('findBySymbol', () => {
    it('returns the highest ranked active coin for the symbol', async () => {
      server.handlers.push(
        ok([
          { id: 999, name: 'Fake Bitcoin', symbol: 'BTC', rank: 5000, is_active: 1 },
          { id: 1, name: 'Bitcoin', symbol: 'BTC', rank: 1, is_active: 1 },
          { id: 2, name: 'Dead Bitcoin', symbol: 'BTC', rank: null, is_active: 0 },
        ]),
      );

      const coin = await client.findBySymbol('BTC');

      expect(coin).toEqual({ cmcId: 1, symbol: 'BTC', name: 'Bitcoin' });
      const url = new URL(server.requests[0].url, server.baseUrl);
      expect(url.pathname).toBe('/v1/cryptocurrency/map');
      expect(url.searchParams.get('symbol')).toBe('BTC');
    });

    it('returns null when no coin matches', async () => {
      server.handlers.push(ok([]));
      await expect(client.findBySymbol('NOPE')).resolves.toBeNull();
    });

    it('returns null when CoinMarketCap rejects the symbol as invalid', async () => {
      server.handlers.push((_req, res) =>
        json(res, 400, { status: { error_code: 400, error_message: 'Invalid value for "symbol": "NOPE"' } }),
      );
      await expect(client.findBySymbol('NOPE')).resolves.toBeNull();
    });

    it('propagates upstream failures', async () => {
      server.handlers.push((_req, res) => json(res, 500, {}));
      await expectExternalError(client.findBySymbol('BTC'), 'UPSTREAM_ERROR');
    });

    it('fails with INVALID_RESPONSE when data is not a list', async () => {
      server.handlers.push(ok({ unexpected: true }));
      await expectExternalError(client.findBySymbol('BTC'), 'INVALID_RESPONSE');
    });
  });
});
