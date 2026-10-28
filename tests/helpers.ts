import { createApplication } from '../src/app';
import type { CoinInfo, PriceProvider, Quote } from '../src/clients/coinmarketcap.client';
import { openDatabase, type Db } from '../src/db/database';

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
  findBySymbolCalls: string[] = [];
  getQuotesCalls: number[][] = [];

  async findBySymbol(symbol: string): Promise<CoinInfo | null> {
    this.findBySymbolCalls.push(symbol);
    if (this.error) throw this.error;
    return this.coins.get(symbol) ?? null;
  }

  async getQuotes(cmcIds: number[], _currency: string, signal?: AbortSignal): Promise<Map<number, Quote>> {
    this.getQuotesCalls.push(cmcIds);
    if (this.error) throw this.error;
    if (signal?.aborted) throw new Error('aborted');
    const result = new Map<number, Quote>();
    for (const id of cmcIds) {
      const price = this.prices.get(id);
      if (price !== undefined) result.set(id, { cmcId: id, price, lastUpdated: '2024-01-01T00:00:00.000Z' });
    }
    return result;
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

export function createTestContext(options: { priceMaxAgeMs?: number } = {}): TestContext {
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
