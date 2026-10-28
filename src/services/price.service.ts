import type { Db } from '../db/database';
import type { PriceProvider } from '../clients/coinmarketcap.client';
import { ExternalApiError, NotFoundError } from '../errors';
import type { Cryptocurrency, CryptocurrencyRepository } from '../repositories/cryptocurrency.repository';
import type { NewPriceRecord, PriceHistoryRepository } from '../repositories/price-history.repository';
import { silentLogger, type Logger } from '../utils/logger';

export interface SyncResult {
  requested: number;
  updated: number;
  /** Symbols CoinMarketCap returned no price for */
  missing: string[];
  fetchedAt: string;
}

export interface LatestPrice {
  id: number;
  symbol: string;
  name: string;
  price: number | null;
  fetchedAt: string | null;
  /** True when the price is older than the freshness threshold (or absent) */
  stale: boolean;
}

export interface LatestPricesResult {
  currency: string;
  data: LatestPrice[];
  /** Present when CoinMarketCap could not be reached and stored prices were served instead */
  warning?: string;
}

export interface PriceServiceOptions {
  currency: string;
  maxAgeMs: number;
  logger?: Logger;
  now?: () => Date;
}

export class PriceService {
  private readonly logger: Logger;
  private readonly now: () => Date;
  private fullSync: Promise<SyncResult> | null = null;

  constructor(
    private readonly db: Db,
    private readonly cryptoRepo: CryptocurrencyRepository,
    private readonly historyRepo: PriceHistoryRepository,
    private readonly provider: PriceProvider,
    private readonly options: PriceServiceOptions,
  ) {
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? (() => new Date());
  }

  get currency(): string {
    return this.options.currency;
  }

  /** Fetches prices for every tracked cryptocurrency. Concurrent calls share one upstream request. */
  syncAll(signal?: AbortSignal): Promise<SyncResult> {
    if (!this.fullSync) {
      const cryptos = this.cryptoRepo.findAllWithPrice(this.currency);
      this.fullSync = this.sync(cryptos, signal).finally(() => {
        this.fullSync = null;
      });
    }
    return this.fullSync;
  }

  /** Fetches current prices from CoinMarketCap and appends them to the price history. */
  async sync(cryptos: Cryptocurrency[], signal?: AbortSignal): Promise<SyncResult> {
    if (cryptos.length === 0) {
      return { requested: 0, updated: 0, missing: [], fetchedAt: this.now().toISOString() };
    }

    const quotes = await this.provider.getQuotes(
      cryptos.map((c) => c.cmcId),
      this.currency,
      signal,
    );
    const fetchedAt = this.now().toISOString();

    const records: NewPriceRecord[] = [];
    const missing: string[] = [];
    for (const crypto of cryptos) {
      const quote = quotes.get(crypto.cmcId);
      if (!quote) {
        missing.push(crypto.symbol);
        continue;
      }
      records.push({ cryptocurrencyId: crypto.id, price: quote.price, sourceUpdatedAt: quote.lastUpdated });
    }

    const updated = this.db.transaction(() => {
      // A cryptocurrency may have been deleted while the request was in flight
      const existing = records.filter((r) => this.cryptoRepo.findById(r.cryptocurrencyId) !== null);
      this.historyRepo.insertMany(existing, this.currency, fetchedAt);
      this.cryptoRepo.touch(
        existing.map((r) => r.cryptocurrencyId),
        fetchedAt,
      );
      return existing.length;
    })();

    if (missing.length > 0) this.logger.warn('No price returned for some cryptocurrencies', { missing });
    return { requested: cryptos.length, updated, missing, fetchedAt };
  }

  /**
   * Returns the latest prices of tracked cryptocurrencies. Prices older than `maxAgeMs` are refreshed
   * from CoinMarketCap first; if it is unavailable, the last stored prices are returned with a warning.
   */
  async getLatest(symbols?: string[], signal?: AbortSignal): Promise<LatestPricesResult> {
    const load = () =>
      symbols
        ? this.cryptoRepo.findBySymbolsWithPrice(symbols, this.currency)
        : this.cryptoRepo.findAllWithPrice(this.currency);

    let items = load();
    if (symbols) {
      const found = new Set(items.map((i) => i.symbol));
      const notTracked = symbols.filter((s) => !found.has(s));
      if (notTracked.length > 0) throw new NotFoundError(`Cryptocurrencies are not tracked: ${notTracked.join(', ')}`);
    }

    let warning: string | undefined;
    const outdated = items.filter((i) => this.isStale(i.priceFetchedAt));
    if (outdated.length > 0) {
      try {
        await this.sync(outdated, signal);
        items = load();
      } catch (error) {
        if (!(error instanceof ExternalApiError)) throw error;
        // Nothing to fall back to: report the upstream failure
        if (items.every((i) => i.price === null)) throw error;
        this.logger.warn('Serving stored prices: CoinMarketCap unavailable', { code: error.code });
        warning = `Prices may be outdated: ${error.message}`;
      }
    }

    return {
      currency: this.currency,
      data: items.map((i) => ({
        id: i.id,
        symbol: i.symbol,
        name: i.name,
        price: i.price,
        fetchedAt: i.priceFetchedAt,
        stale: this.isStale(i.priceFetchedAt),
      })),
      ...(warning ? { warning } : {}),
    };
  }

  private isStale(fetchedAt: string | null): boolean {
    return fetchedAt === null || this.now().getTime() - Date.parse(fetchedAt) > this.options.maxAgeMs;
  }
}
