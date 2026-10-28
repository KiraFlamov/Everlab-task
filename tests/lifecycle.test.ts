import { EventEmitter } from 'node:events';
import http from 'node:http';
import { openDatabase } from '../src/db/database';
import type { PriceSyncJob } from '../src/jobs/price-sync.job';
import { createShutdown, registerSignalHandlers } from '../src/lifecycle';
import { silentLogger } from '../src/utils/logger';

async function startServer(): Promise<http.Server> {
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

describe('Graceful shutdown', () => {
  it('stops the job, closes the server and the database, then exits with 0', async () => {
    const server = await startServer();
    const db = openDatabase(':memory:');
    const order: string[] = [];
    const job = { stop: jest.fn(async () => void order.push('job')) } as unknown as PriceSyncJob;
    server.on('close', () => order.push('server'));
    const exit = jest.fn((code: number) => void order.push(`exit:${code}`));

    await createShutdown({ server, job, db, logger: silentLogger, exit })('SIGTERM');

    expect(order).toEqual(['job', 'server', 'exit:0']);
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
