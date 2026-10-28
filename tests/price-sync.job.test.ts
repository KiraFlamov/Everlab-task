import type { Quote } from '../src/clients/coinmarketcap.client';
import { ExternalApiError } from '../src/errors';
import { PriceSyncJob } from '../src/jobs/price-sync.job';
import { createTestContext, seedCrypto, type TestContext } from './helpers';

const INTERVAL = 1_000;

const historyCount = (ctx: TestContext) =>
  (ctx.db.prepare('SELECT COUNT(*) AS n FROM price_history').get() as { n: number }).n;

describe('PriceSyncJob', () => {
  let ctx: TestContext;
  let job: PriceSyncJob;

  beforeEach(() => {
    jest.useFakeTimers();
    ctx = createTestContext();
    seedCrypto(ctx.db, 'BTC', 1);
    seedCrypto(ctx.db, 'ETH', 1027);
    job = new PriceSyncJob(ctx.priceService, { intervalMs: INTERVAL });
  });

  afterEach(async () => {
    await job.stop();
    jest.useRealTimers();
    ctx.db.close();
  });

  it('synchronizes immediately on start and saves prices to the history', async () => {
    job.start();
    await jest.advanceTimersByTimeAsync(0);

    expect(ctx.provider.getQuotesCalls).toEqual([[1, 1027]]);
    expect(historyCount(ctx)).toBe(2);
    const updated = ctx.db.prepare('SELECT updated_at FROM cryptocurrencies').all();
    expect(updated).toEqual([{ updated_at: '2024-01-01T00:00:00.000Z' }, { updated_at: '2024-01-01T00:00:00.000Z' }]);
  });

  it('repeats synchronization every interval', async () => {
    job.start();
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(INTERVAL * 3);

    expect(ctx.provider.getQuotesCalls).toHaveLength(4);
    expect(historyCount(ctx)).toBe(8);
  });

  it('keeps running after external API failures and recovers', async () => {
    ctx.provider.error = new ExternalApiError('TIMEOUT', 'CoinMarketCap request timed out');
    job.start();
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(INTERVAL);

    expect(job.failures).toBe(2);
    expect(job.isRunning).toBe(true);
    expect(historyCount(ctx)).toBe(0);

    ctx.provider.error = null;
    await jest.advanceTimersByTimeAsync(INTERVAL);

    expect(job.failures).toBe(0);
    expect(historyCount(ctx)).toBe(2);
  });

  it('survives unexpected (non-API) errors', async () => {
    ctx.provider.getQuotes = jest.fn().mockRejectedValue(new TypeError('boom'));

    await expect(job.runOnce()).resolves.toBeNull();
    expect(job.failures).toBe(1);
  });

  it('skips coins without a price and stores the rest', async () => {
    ctx.provider.prices.delete(1027);

    const result = await job.runOnce();

    expect(result).toMatchObject({ requested: 2, updated: 1, missing: ['ETH'] });
    expect(historyCount(ctx)).toBe(1);
  });

  it('does not call the external API when nothing is tracked', async () => {
    ctx.db.exec('DELETE FROM cryptocurrencies');

    const result = await job.runOnce();

    expect(result).toMatchObject({ requested: 0, updated: 0 });
    expect(ctx.provider.getQuotesCalls).toHaveLength(0);
  });

  it('stops scheduling runs after stop()', async () => {
    job.start();
    await jest.advanceTimersByTimeAsync(0);
    await job.stop();
    await jest.advanceTimersByTimeAsync(INTERVAL * 5);

    expect(job.isRunning).toBe(false);
    expect(ctx.provider.getQuotesCalls).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('aborts the in-flight request on stop() and waits for it to finish', async () => {
    let receivedSignal: AbortSignal | undefined;
    ctx.provider.getQuotes = jest.fn(
      (_ids: number[], _currency: string, signal?: AbortSignal) =>
        new Promise<Map<number, Quote>>((_resolve, reject) => {
          receivedSignal = signal;
          signal?.addEventListener('abort', () => reject(new ExternalApiError('ABORTED', 'aborted')));
        }),
    );
    job.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(receivedSignal?.aborted).toBe(false);

    await job.stop();

    expect(receivedSignal?.aborted).toBe(true);
    expect(job.failures).toBe(0); // abort on shutdown is not a failure
    expect(historyCount(ctx)).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('never runs synchronizations concurrently', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    ctx.provider.getQuotes = jest.fn(async (_ids: number[], _currency: string, signal?: AbortSignal) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        // slower than the interval; abortable like the real client
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, INTERVAL * 3);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new ExternalApiError('ABORTED', 'aborted'));
          });
        });
      } finally {
        inFlight--;
      }
      return new Map<number, Quote>();
    });

    job.start();
    await jest.advanceTimersByTimeAsync(INTERVAL * 10);

    expect(maxInFlight).toBe(1);
    // each cycle = 3 intervals of work + 1 interval pause
    expect((ctx.provider.getQuotes as jest.Mock).mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('ignores repeated start() calls', async () => {
    job.start();
    job.start();
    await jest.advanceTimersByTimeAsync(0);

    expect(ctx.provider.getQuotesCalls).toHaveLength(1);
  });

  it('does not store prices for a cryptocurrency deleted during synchronization', async () => {
    const original = ctx.provider.getQuotes.bind(ctx.provider);
    ctx.provider.getQuotes = jest.fn(async (ids: number[], currency: string) => {
      ctx.db.exec("DELETE FROM cryptocurrencies WHERE symbol = 'ETH'");
      return original(ids, currency);
    });

    const result = await job.runOnce();

    expect(result?.updated).toBe(1);
    expect(historyCount(ctx)).toBe(1);
  });
});
