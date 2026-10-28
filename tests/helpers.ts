import { createApplication } from '../src/app';
import type { CoinInfo, PriceProvider, Quote } from '../src/clients/coinmarketcap.client';
import { openDatabase, type Db } from '../src/db/database';
import { ExternalApiError } from '../src/errors';

export const API_KEY = 'test-full-access-key-0123456789';
export const API_KEY_READONLY = 'test-read-only-key-0123456789';
export const AUTH = { Authorization: `Bearer ${API_KEY}` };
export const AUTH_READONLY = { Authorization: `Bearer ${API_KEY_READONLY}` };

/** In-memory stand-in for CoinMarketCap with controllable data and failures. */
export class FakePriceProvider implements PriceProvider {
  coins = new Map<string, CoinInfo>([
    ['BTC', { cmcId: 1, symbol: 'BTC', name: 'Bitcoin' }],
    ['ETH', { cmcId: 1027, symbol: 'ETH', name: 'Ethereum' }],
    ['SOL', { cmcId: 5426, symbol: 'SOL', name: 'Solana' }],
  ]);
  prices = new Map<number, number>([
    [1, 50_000],
    [1027, 3_000],
    [5426, 150],
  ]);
  /** When set, every call fails with this error */
  error: Error | null = null;
  /** When true, calls never complete unless aborted via their signal (like a stuck upstream) */
  hang = false;
  findBySymbolCalls: string[] = [];
  getQuotesCalls: number[][] = [];

  async findBySymbol(symbol: string, signal?: AbortSignal): Promise<CoinInfo | null> {
    this.findBySymbolCalls.push(symbol);
    await this.respond(signal);
    return this.coins.get(symbol) ?? null;
  }

  async getQuotes(cmcIds: number[], _currency: string, signal?: AbortSignal): Promise<Map<number, Quote>> {
    this.getQuotesCalls.push(cmcIds);
    await this.respond(signal);
    const result = new Map<number, Quote>();
    for (const id of cmcIds) {
      const price = this.prices.get(id);
      if (price !== undefined) result.set(id, { cmcId: id, price, lastUpdated: '2024-01-01T00:00:00.000Z' });
    }
    return result;
  }

  private respond(signal?: AbortSignal): Promise<void> {
    const aborted = () => new ExternalApiError('ABORTED', 'CoinMarketCap request was aborted');
    if (signal?.aborted) return Promise.reject(aborted());
    if (this.error) return Promise.reject(this.error);
    if (!this.hang) return Promise.resolve();
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(aborted()), { once: true });
    });
  }
}

/** Polls until the condition holds (for waiting on asynchronous side effects in tests). */
export async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export class TestClock {
  constructor(private current = new Date('2024-01-01T00:00:00.000Z')) {}
  now = (): Date => new Date(this.current);
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export interface TestContext {
  db: Db;
  provider: FakePriceProvider;
  clock: TestClock;
  app: ReturnType<typeof createApplication>['app'];
  priceService: ReturnType<typeof createApplication>['priceService'];
}

export function createTestContext(
  options: { priceMaxAgeMs?: number; shutdownSignal?: AbortSignal } = {},
): TestContext {
  const db = openDatabase(':memory:');
  const provider = new FakePriceProvider();
  const clock = new TestClock();
  const { app, priceService } = createApplication({
    db,
    priceProvider: provider,
    apiKey: API_KEY,
    apiKeyReadonly: API_KEY_READONLY,
    currency: 'USD',
    priceMaxAgeMs: options.priceMaxAgeMs ?? 60_000,
    shutdownSignal: options.shutdownSignal,
    now: clock.now,
  });
  return { db, provider, clock, app, priceService };
}

/** Inserts a tracked cryptocurrency directly, bypassing the API. */
export function seedCrypto(db: Db, symbol: string, cmcId: number, name = symbol): number {
  const now = '2024-01-01T00:00:00.000Z';
  const result = db
    .prepare('INSERT INTO cryptocurrencies (symbol, name, cmc_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(symbol, name, cmcId, now, now);
  return Number(result.lastInsertRowid);
}

export function seedPrice(db: Db, cryptoId: number, price: number, fetchedAt: string, currency = 'USD'): void {
  db.prepare(
    'INSERT INTO price_history (cryptocurrency_id, price, currency, fetched_at, source_updated_at) VALUES (?, ?, ?, ?, NULL)',
  ).run(cryptoId, price, currency, fetchedAt);
}
