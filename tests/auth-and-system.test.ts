import request from 'supertest';
import { API_KEY, AUTH, AUTH_READONLY, createTestContext, type TestContext } from './helpers';

describe('Authentication', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    if (ctx.db.open) ctx.db.close();
  });

  it('accepts the full-access key', async () => {
    const res = await request(ctx.app).get('/api/v1/cryptocurrencies').set(AUTH);
    expect(res.status).toBe(200);
  });

  it('accepts the read-only key for GET requests', async () => {
    const res = await request(ctx.app).get('/api/v1/cryptocurrencies').set(AUTH_READONLY);
    expect(res.status).toBe(200);
  });

  it('accepts a case-insensitive scheme', async () => {
    const res = await request(ctx.app).get('/api/v1/cryptocurrencies').set('Authorization', `bearer ${API_KEY}`);
    expect(res.status).toBe(200);
  });

  it.each([
    ['missing header', undefined],
    ['wrong scheme', `Basic ${API_KEY}`],
    ['empty token', 'Bearer '],
    ['invalid key', 'Bearer wrong-key'],
    ['key prefix', `Bearer ${API_KEY.slice(0, -1)}`],
    ['extra parts', `Bearer ${API_KEY} extra`],
  ])('rejects requests with %s', async (_case, header) => {
    const req = request(ctx.app).get('/api/v1/cryptocurrencies');
    if (header !== undefined) req.set('Authorization', header);
    const res = await req;

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.headers['www-authenticate']).toMatch(/^Bearer/);
  });
});

describe('System endpoints and error handling', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    if (ctx.db.open) ctx.db.close();
  });

  it('GET /health reports ok without authentication', async () => {
    const res = await request(ctx.app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /health reports 503 when the database is unavailable', async () => {
    ctx.db.close();

    const res = await request(ctx.app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('DATABASE_UNAVAILABLE');
  });

  it('GET /docs/openapi.json serves the OpenAPI 3.0 document', async () => {
    const res = await request(ctx.app).get('/docs/openapi.json');

    expect(res.status).toBe(200);
    expect(res.body.openapi).toMatch(/^3\.0\./);
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/cryptocurrencies',
        '/api/v1/cryptocurrencies/{id}',
        '/api/v1/cryptocurrencies/{id}/history',
        '/api/v1/prices',
      ]),
    );
  });

  it('GET /docs/ serves Swagger UI', async () => {
    const res = await request(ctx.app).get('/docs/');

    expect(res.status).toBe(200);
    expect(res.text).toContain('swagger-ui');
  });

  it('returns JSON 404 for unknown routes', async () => {
    const res = await request(ctx.app).get('/api/v1/unknown').set(AUTH);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/cryptocurrencies')
      .set(AUTH)
      .set('Content-Type', 'application/json')
      .send('{"symbol": ');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('returns 413 for an oversized body', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/cryptocurrencies')
      .set(AUTH)
      .send({ symbol: 'BTC', name: 'x'.repeat(20_000) });

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects a non-JSON body as validation error', async () => {
    const res = await request(ctx.app).post('/api/v1/cryptocurrencies').set(AUTH).type('form').send('symbol=BTC');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('hides internal error details from clients', async () => {
    ctx.provider.findBySymbol = jest.fn().mockRejectedValue(new Error('secret internal failure'));

    const res = await request(ctx.app).post('/api/v1/cryptocurrencies').set(AUTH).send({ symbol: 'BTC' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });
});
