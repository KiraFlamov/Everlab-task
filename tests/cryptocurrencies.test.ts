import request from 'supertest';
import { ExternalApiError } from '../src/errors';
import { AUTH, AUTH_READONLY, createTestContext, seedCrypto, seedPrice, type TestContext } from './helpers';

describe('Cryptocurrencies API', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    ctx.db.close();
  });

  describe('POST /api/v1/cryptocurrencies', () => {
    it('starts tracking a cryptocurrency resolved via CoinMarketCap and fetches its price', async () => {
      const res = await request(ctx.app).post('/api/v1/cryptocurrencies').set(AUTH).send({ symbol: 'btc' });

      expect(res.status).toBe(201);
      expect(res.headers.location).toBe(`/api/v1/cryptocurrencies/${res.body.data.id}`);
      expect(res.body.data).toEqual({
        id: expect.any(Number),
        symbol: 'BTC',
        name: 'Bitcoin',
        cmcId: 1,
        latestPrice: { value: 50_000, currency: 'USD', fetchedAt: '2024-01-01T00:00:00.000Z' },
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      });
      expect(ctx.provider.findBySymbolCalls).toEqual(['BTC']);
      const rows = ctx.db.prepare('SELECT COUNT(*) AS n FROM price_history').get() as { n: number };
      expect(rows.n).toBe(1);
    });

    it('uses a custom name when provided', async () => {
      const res = await request(ctx.app)
        .post('/api/v1/cryptocurrencies')
        .set(AUTH)
        .send({ symbol: 'ETH', name: '  Ether  ' });

      expect(res.status).toBe(201);
      expect(res.body.data.name).toBe('Ether');
    });

    it('still creates the record when the initial price fetch fails', async () => {
      ctx.provider.getQuotes = jest.fn().mockRejectedValue(new ExternalApiError('TIMEOUT', 'timed out'));

      const res = await request(ctx.app).post('/api/v1/cryptocurrencies').set(AUTH).send({ symbol: 'SOL' });

      expect(res.status).toBe(201);
      expect(res.body.data.latestPrice).toBeNull();
    });

    it.each([
      [{}, 'symbol'],
      [{ symbol: '' }, 'symbol'],
      [{ symbol: 'BTC-USD' }, 'symbol'],
      [{ symbol: 123 }, 'symbol'],
      [{ symbol: 'A'.repeat(21) }, 'symbol'],
      [{ symbol: 'BTC', name: '' }, 'name'],
      [{ symbol: 'BTC', name: 'x'.repeat(101) }, 'name'],
      [{ symbol: 'BTC', name: 'bad\nname' }, 'name'],
      [{ symbol: 'BTC', extra: true }, 'extra'],
    ])('rejects invalid body %j', async (body, field) => {
      const res = await request(ctx.app).post('/api/v1/cryptocurrencies').set(AUTH).send(body);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ field })]));
      expect(ctx.provider.findBySymbolCalls).toHaveLength(0);
    });

    it('rejects a non-object JSON body', async () => {
      const res = await request(ctx.app).post('/api/v1/cryptocurrencies').set(AUTH).send(['BTC']);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 409 when the symbol is already tracked', async () => {
      seedCrypto(ctx.db, 'BTC', 1);

      const res = await request(ctx.app).post('/api/v1/cryptocurrencies').set(AUTH).send({ symbol: 'BTC' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
    });

    it('returns 422 when CoinMarketCap does not know the symbol', async () => {
      const res = await request(ctx.app).post('/api/v1/cryptocurrencies').set(AUTH).send({ symbol: 'NOPE' });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('UNKNOWN_SYMBOL');
    });

    it('returns 503 when CoinMarketCap is unavailable', async () => {
      ctx.provider.error = new ExternalApiError('TIMEOUT', 'CoinMarketCap request timed out');

      const res = await request(ctx.app).post('/api/v1/cryptocurrencies').set(AUTH).send({ symbol: 'BTC' });

      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('30');
      expect(res.body.error).toEqual({ code: 'EXTERNAL_API_TIMEOUT', message: 'CoinMarketCap request timed out' });
      expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM cryptocurrencies').get()).toEqual({ n: 0 });
    });

    it('returns 502 when CoinMarketCap rejects the API key', async () => {
      ctx.provider.error = new ExternalApiError('UNAUTHORIZED', 'CoinMarketCap rejected the API key', 401);

      const res = await request(ctx.app).post('/api/v1/cryptocurrencies').set(AUTH).send({ symbol: 'BTC' });

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('EXTERNAL_API_UNAUTHORIZED');
    });

    it('is forbidden for the read-only key', async () => {
      const res = await request(ctx.app).post('/api/v1/cryptocurrencies').set(AUTH_READONLY).send({ symbol: 'BTC' });

      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/v1/cryptocurrencies', () => {
    it('lists tracked cryptocurrencies with their latest price and pagination', async () => {
      const btc = seedCrypto(ctx.db, 'BTC', 1, 'Bitcoin');
      seedCrypto(ctx.db, 'ETH', 1027, 'Ethereum');
      seedCrypto(ctx.db, 'SOL', 5426, 'Solana');
      seedPrice(ctx.db, btc, 40_000, '2023-12-31T00:00:00.000Z');
      seedPrice(ctx.db, btc, 41_000, '2023-12-31T12:00:00.000Z');

      const res = await request(ctx.app).get('/api/v1/cryptocurrencies?limit=2&offset=0').set(AUTH);

      expect(res.status).toBe(200);
      expect(res.body.pagination).toEqual({ limit: 2, offset: 0, total: 3 });
      expect(res.body.data.map((c: { symbol: string }) => c.symbol)).toEqual(['BTC', 'ETH']);
      expect(res.body.data[0].latestPrice).toEqual({
        value: 41_000,
        currency: 'USD',
        fetchedAt: '2023-12-31T12:00:00.000Z',
      });
      expect(res.body.data[1].latestPrice).toBeNull();
    });

    it('returns an empty list when nothing is tracked', async () => {
      const res = await request(ctx.app).get('/api/v1/cryptocurrencies').set(AUTH);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: [], pagination: { limit: 20, offset: 0, total: 0 } });
    });

    it.each(['limit=0', 'limit=101', 'limit=abc', 'offset=-1', 'limit=1&limit=2', 'unknown=1'])(
      'rejects invalid query %s',
      async (query) => {
        const res = await request(ctx.app).get(`/api/v1/cryptocurrencies?${query}`).set(AUTH);

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      },
    );
  });

  describe('GET /api/v1/cryptocurrencies/:id', () => {
    it('returns the cryptocurrency', async () => {
      const id = seedCrypto(ctx.db, 'BTC', 1, 'Bitcoin');

      const res = await request(ctx.app).get(`/api/v1/cryptocurrencies/${id}`).set(AUTH_READONLY);

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id, symbol: 'BTC', name: 'Bitcoin', cmcId: 1, latestPrice: null });
    });

    it('returns 404 for an unknown id', async () => {
      const res = await request(ctx.app).get('/api/v1/cryptocurrencies/999').set(AUTH);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it.each(['0', '-1', 'abc', '1.5', '99999999999999999999'])('returns 400 for invalid id %s', async (id) => {
      const res = await request(ctx.app).get(`/api/v1/cryptocurrencies/${id}`).set(AUTH);

      expect(res.status).toBe(400);
      expect(res.body.error.details).toEqual([{ field: 'id', message: 'Must be a positive integer' }]);
    });
  });

  describe('PATCH /api/v1/cryptocurrencies/:id', () => {
    it('updates the name and the update timestamp', async () => {
      const id = seedCrypto(ctx.db, 'BTC', 1, 'Bitcoin');
      ctx.clock.advance(5_000);

      const res = await request(ctx.app).patch(`/api/v1/cryptocurrencies/${id}`).set(AUTH).send({ name: 'Digital gold' });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Digital gold');
      expect(res.body.data.updatedAt).toBe('2024-01-01T00:00:05.000Z');
    });

    it('returns 404 for an unknown id', async () => {
      const res = await request(ctx.app).patch('/api/v1/cryptocurrencies/999').set(AUTH).send({ name: 'X' });

      expect(res.status).toBe(404);
    });

    it.each([[{}], [{ name: '' }], [{ name: 'X', symbol: 'ETH' }], [{ name: null }]])(
      'rejects invalid body %j',
      async (body) => {
        const id = seedCrypto(ctx.db, 'BTC', 1);

        const res = await request(ctx.app).patch(`/api/v1/cryptocurrencies/${id}`).set(AUTH).send(body);

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      },
    );

    it('is forbidden for the read-only key', async () => {
      const id = seedCrypto(ctx.db, 'BTC', 1);

      const res = await request(ctx.app).patch(`/api/v1/cryptocurrencies/${id}`).set(AUTH_READONLY).send({ name: 'X' });

      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /api/v1/cryptocurrencies/:id', () => {
    it('deletes the cryptocurrency together with its price history', async () => {
      const id = seedCrypto(ctx.db, 'BTC', 1);
      seedPrice(ctx.db, id, 40_000, '2023-12-31T00:00:00.000Z');

      const res = await request(ctx.app).delete(`/api/v1/cryptocurrencies/${id}`).set(AUTH);

      expect(res.status).toBe(204);
      expect(res.text).toBe('');
      expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM cryptocurrencies').get()).toEqual({ n: 0 });
      expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM price_history').get()).toEqual({ n: 0 });
    });

    it('returns 404 for an unknown id', async () => {
      const res = await request(ctx.app).delete('/api/v1/cryptocurrencies/999').set(AUTH);

      expect(res.status).toBe(404);
    });

    it('returns 400 for an invalid id', async () => {
      const res = await request(ctx.app).delete('/api/v1/cryptocurrencies/abc').set(AUTH);

      expect(res.status).toBe(400);
    });

    it('is forbidden for the read-only key', async () => {
      const id = seedCrypto(ctx.db, 'BTC', 1);

      const res = await request(ctx.app).delete(`/api/v1/cryptocurrencies/${id}`).set(AUTH_READONLY);

      expect(res.status).toBe(403);
      expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM cryptocurrencies').get()).toEqual({ n: 1 });
    });
  });
});
