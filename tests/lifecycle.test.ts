import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { openDatabase } from '../src/db/database';
import type { PriceSyncJob } from '../src/jobs/price-sync.job';
import { createShutdown, registerSignalHandlers } from '../src/lifecycle';
import { silentLogger } from '../src/utils/logger';
import { AUTH, createTestContext, seedCrypto, seedPrice as seedStoredPrice, waitFor } from './helpers';

async function startServer(): Promise<http.Server> {
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

describe('Graceful shutdown', () => {
  it('aborts upstream requests, stops the job, closes the server and the database, then exits with 0', async () => {
    const server = await startServer();
    const db = openDatabase(':memory:');
    const order: string[] = [];
    const requestsAbortController = new AbortController();
    requestsAbortController.signal.addEventListener('abort', () => order.push('abort'));
    const job = { stop: jest.fn(async () => void order.push('job')) } as unknown as PriceSyncJob;
    server.on('close', () => order.push('server'));
    const exit = jest.fn((code: number) => void order.push(`exit:${code}`));

    await createShutdown({ server, job, db, requestsAbortController, logger: silentLogger, exit })('SIGTERM');

    expect(order).toEqual(['abort', 'job', 'server', 'exit:0']);
    expect(server.listening).toBe(false);
    expect(db.open).toBe(false);
  });

  it('is idempotent when signals arrive repeatedly', async () => {
    const server = await startServer();
    const db = openDatabase(':memory:');
    const job = { stop: jest.fn().mockResolvedValue(undefined) } as unknown as PriceSyncJob;
    const exit = jest.fn();
    const shutdown = createShutdown({ server, job, db, logger: silentLogger, exit });

    await Promise.all([shutdown('SIGINT'), shutdown('SIGTERM'), shutdown('SIGINT')]);

    expect(job.stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits with 1 when shutdown fails', async () => {
    const server = await startServer();
    const db = openDatabase(':memory:');
    const job = { stop: jest.fn().mockRejectedValue(new Error('stuck')) } as unknown as PriceSyncJob;
    const exit = jest.fn();

    await createShutdown({ server, job, db, logger: silentLogger, exit })('SIGTERM');

    expect(exit).toHaveBeenCalledWith(1);
    server.close();
    db.close();
  });

  it('forces exit when graceful shutdown takes too long', async () => {
    const server = await startServer();
    const db = openDatabase(':memory:');
    const job = { stop: () => new Promise<void>(() => undefined) } as unknown as PriceSyncJob;
    const exit = jest.fn();

    void createShutdown({ server, job, db, logger: silentLogger, exit, timeoutMs: 50 })('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(exit).toHaveBeenCalledWith(1);
    server.close();
    db.close();
  });

  it('works without a background job', async () => {
    const server = await startServer();
    const db = openDatabase(':memory:');
    const exit = jest.fn();

    await createShutdown({ server, job: null, db, logger: silentLogger, exit })('SIGINT');

    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe('Shutdown with HTTP requests waiting for CoinMarketCap', () => {
  async function startApp(seedPrice: boolean) {
    const requestsAbortController = new AbortController();
    const ctx = createTestContext({ shutdownSignal: requestsAbortController.signal });
    const id = seedCrypto(ctx.db, 'BTC', 1);
    if (seedPrice) seedStoredPrice(ctx.db, id, 42_000, '2023-12-31T00:00:00.000Z');
    ctx.provider.hang = true;
    const server = ctx.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { ctx, server, url, requestsAbortController };
  }

  it.each([
    ['GET /prices with no stored prices', 'GET', '/api/v1/prices', false, 503],
    ['GET /prices with stored prices', 'GET', '/api/v1/prices', true, 200],
    ['POST /cryptocurrencies', 'POST', '/api/v1/cryptocurrencies', false, 503],
  ])('%s: aborts the upstream call and exits with 0 quickly', async (_name, method, path, seed, status) => {
    const { ctx, server, url, requestsAbortController } = await startApp(seed);
    const response = fetch(`${url}${path}`, {
      method,
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify({ symbol: 'ETH' }) } : {}),
    });
    await waitFor(() => ctx.provider.getQuotesCalls.length + ctx.provider.findBySymbolCalls.length > 0);

    const exit = jest.fn();
    const startedAt = Date.now();
    await createShutdown({
      server,
      job: null,
      db: ctx.db,
      requestsAbortController,
      logger: silentLogger,
      exit,
      timeoutMs: 3_000,
    })('SIGTERM');

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    const res = await response;
    expect(res.status).toBe(status);
    const body = (await res.json()) as { error: { code: string }; data: unknown[] };
    if (status === 503) expect(body.error.code).toBe('EXTERNAL_API_ABORTED');
    else expect(body.data[0]).toMatchObject({ price: 42_000, stale: true });
  });

  it('rejects upstream calls immediately for requests arriving after the abort', async () => {
    const requestsAbortController = new AbortController();
    const ctx = createTestContext({ shutdownSignal: requestsAbortController.signal });
    seedCrypto(ctx.db, 'BTC', 1);
    ctx.provider.hang = true;
    requestsAbortController.abort();

    const res = await request(ctx.app).get('/api/v1/prices').set(AUTH);

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('EXTERNAL_API_ABORTED');
    ctx.db.close();
  });
});

describe('registerSignalHandlers', () => {
  it.each(['SIGINT', 'SIGTERM'])('triggers shutdown on %s', (signal) => {
    const emitter = new EventEmitter();
    const shutdown = jest.fn().mockResolvedValue(undefined);

    registerSignalHandlers(shutdown, emitter);
    emitter.emit(signal);

    expect(shutdown).toHaveBeenCalledWith(signal);
  });

  it('can unregister the handlers', () => {
    const emitter = new EventEmitter();
    const shutdown = jest.fn().mockResolvedValue(undefined);

    registerSignalHandlers(shutdown, emitter)();
    emitter.emit('SIGINT');
    emitter.emit('SIGTERM');

    expect(shutdown).not.toHaveBeenCalled();
  });
});
