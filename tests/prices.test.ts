import request from 'supertest';
import { ExternalApiError } from '../src/errors';
import { AUTH, AUTH_READONLY, createTestContext, seedCrypto, seedPrice, type TestContext } from './helpers';

describe('Prices API', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext({ priceMaxAgeMs: 60_000 });
  });

  afterEach(() => {
    ctx.db.close();
  });

  describe('GET /api/v1/prices', () => {
    it('fetches prices from CoinMarketCap and stores them in the history', async () => {
      seedCrypto(ctx.db, 'BTC', 1, 'Bitcoin');
      seedCrypto(ctx.db, 'ETH', 1027, 'Ethereum');

      const res = await request(ctx.app).get('/api/v1/prices').set(AUTH_READONLY);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        currency: 'USD',
        data: [
          { id: 1, symbol: 'BTC', name: 'Bitcoin', price: 50_000, fetchedAt: '2024-01-01T00:00:00.000Z', stale: false },
          { id: 2, symbol: 'ETH', name: 'Ethereum', price: 3_000, fetchedAt: '2024-01-01T00:00:00.000Z', stale: false },
        ],
      });
      expect(ctx.provider.getQuotesCalls).toEqual([[1, 1027]]);
      expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM price_history').get()).toEqual({ n: 2 });
    });

    it('serves fresh stored prices without calling CoinMarketCap', async () => {
      const btc = seedCrypto(ctx.db, 'BTC', 1);
      seedPrice(ctx.db, btc, 42_000, '2023-12-31T23:59:30.000Z');

      const res = await request(ctx.app).get('/api/v1/prices').set(AUTH);

      expect(res.status).toBe(200);
      expect(res.body.data[0]).toMatchObject({ price: 42_000, stale: false });
      expect(ctx.provider.getQuotesCalls).toHaveLength(0);
    });

    it('refreshes only outdated prices', async () => {
      const btc = seedCrypto(ctx.db, 'BTC', 1);
      const eth = seedCrypto(ctx.db, 'ETH', 1027);
      seedPrice(ctx.db, btc, 42_000, '2023-12-31T23:59:30.000Z');
      seedPrice(ctx.db, eth, 2_000, '2023-12-31T00:00:00.000Z');

      const res = await request(ctx.app).get('/api/v1/prices').set(AUTH);

      expect(ctx.provider.getQuotesCalls).toEqual([[1027]]);
      expect(res.body.data.map((p: { price: number }) => p.price)).toEqual([42_000, 3_000]);
    });

    it('filters by symbols (case-insensitive, de-duplicated)', async () => {
      seedCrypto(ctx.db, 'BTC', 1);
      seedCrypto(ctx.db, 'ETH', 1027);

      const res = await request(ctx.app).get('/api/v1/prices?symbols=eth,ETH').set(AUTH);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].symbol).toBe('ETH');
      expect(ctx.provider.getQuotesCalls).toEqual([[1027]]);
    });

    it('returns an empty list without calling CoinMarketCap when nothing is tracked', async () => {
      const res = await request(ctx.app).get('/api/v1/prices').set(AUTH);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ currency: 'USD', data: [] });
      expect(ctx.provider.getQuotesCalls).toHaveLength(0);
    });

    it('falls back to stored prices with a warning when CoinMarketCap is unavailable', async () => {
      const btc = seedCrypto(ctx.db, 'BTC', 1);
      seedPrice(ctx.db, btc, 42_000, '2023-12-31T00:00:00.000Z');
      ctx.provider.error = new ExternalApiError('UPSTREAM_ERROR', 'CoinMarketCap responded with 500', 500);

      const res = await request(ctx.app).get('/api/v1/prices').set(AUTH);

      expect(res.status).toBe(200);
      expect(res.body.data[0]).toMatchObject({ price: 42_000, fetchedAt: '2023-12-31T00:00:00.000Z', stale: true });
      expect(res.body.warning).toBe('Prices may be outdated: CoinMarketCap responded with 500');
    });

    it('returns 503 when CoinMarketCap is unavailable and there are no stored prices', async () => {
      seedCrypto(ctx.db, 'BTC', 1);
      ctx.provider.error = new ExternalApiError('NETWORK', 'CoinMarketCap is unreachable');

      const res = await request(ctx.app).get('/api/v1/prices').set(AUTH);

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('EXTERNAL_API_NETWORK');
    });

    it('returns 404 when a requested symbol is not tracked', async () => {
      seedCrypto(ctx.db, 'BTC', 1);

      const res = await request(ctx.app).get('/api/v1/prices?symbols=BTC,DOGE').set(AUTH);

      expect(res.status).toBe(404);
      expect(res.body.error.message).toBe('Cryptocurrencies are not tracked: DOGE');
    });

    it.each(['symbols=', 'symbols=BTC,,ETH', 'symbols=BTC;DROP', 'symbols=A&symbols=B', 'foo=bar'])(
      'returns 400 for invalid query %s',
      async (query) => {
        const res = await request(ctx.app).get(`/api/v1/prices?${query}`).set(AUTH);

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      },
    );

    it('returns 401 without an API key', async () => {
      const res = await request(ctx.app).get('/api/v1/prices');

      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/cryptocurrencies/:id/history', () => {
    let btc: number;

    beforeEach(() => {
      btc = seedCrypto(ctx.db, 'BTC', 1, 'Bitcoin');
      seedPrice(ctx.db, btc, 100, '2024-01-01T00:00:00.000Z');
      seedPrice(ctx.db, btc, 200, '2024-01-02T00:00:00.000Z');
      seedPrice(ctx.db, btc, 300, '2024-01-03T00:00:00.000Z');
      seedPrice(ctx.db, btc, 999, '2024-01-03T00:00:00.000Z', 'EUR');
      const eth = seedCrypto(ctx.db, 'ETH', 1027);
      seedPrice(ctx.db, eth, 10, '2024-01-02T00:00:00.000Z');
    });

    it('returns the price history newest first, in the application currency only', async () => {
      const res = await request(ctx.app).get(`/api/v1/cryptocurrencies/${btc}/history`).set(AUTH);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        cryptocurrency: { id: btc, symbol: 'BTC', name: 'Bitcoin' },
        currency: 'USD',
        data: [
          { price: 300, fetchedAt: '2024-01-03T00:00:00.000Z', sourceUpdatedAt: null },
          { price: 200, fetchedAt: '2024-01-02T00:00:00.000Z', sourceUpdatedAt: null },
          { price: 100, fetchedAt: '2024-01-01T00:00:00.000Z', sourceUpdatedAt: null },
        ],
        pagination: { limit: 100, offset: 0, total: 3 },
      });
    });

    it('supports date range, ordering and pagination', async () => {
      const res = await request(ctx.app)
        .get(
          `/api/v1/cryptocurrencies/${btc}/history?from=2024-01-02&to=2024-01-03T00:00:00%2B00:00&order=asc&limit=1&offset=1`,
        )
        .set(AUTH);

      expect(res.status).toBe(200);
      expect(res.body.data.map((p: { price: number }) => p.price)).toEqual([300]);
      expect(res.body.pagination).toEqual({ limit: 1, offset: 1, total: 2 });
    });

    it('returns 404 for an unknown cryptocurrency', async () => {
      const res = await request(ctx.app).get('/api/v1/cryptocurrencies/999/history').set(AUTH);

      expect(res.status).toBe(404);
    });

    it.each([
      'from=yesterday',
      'from=2024-02-31',
      'from=2024-01-01T00:00:00',
      'to=2024-13-01',
      'from=2024-01-03&to=2024-01-01',
      'limit=1001',
      'order=random',
      'page=2',
    ])('returns 400 for invalid query %s', async (query) => {
      const res = await request(ctx.app).get(`/api/v1/cryptocurrencies/${btc}/history?${query}`).set(AUTH);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});
