import type { PriceProvider } from '../clients/coinmarketcap.client';
import { AppError, ConflictError, NotFoundError } from '../errors';
import type { CryptocurrencyRepository, CryptocurrencyWithPrice } from '../repositories/cryptocurrency.repository';
import type { PriceHistoryRepository, PriceRecord } from '../repositories/price-history.repository';
import { silentLogger, type Logger } from '../utils/logger';
import type { PriceService } from './price.service';

export interface CreateCryptocurrencyInput {
  symbol: string;
  name?: string;
}

export interface UpdateCryptocurrencyInput {
  name: string;
}

export interface HistoryParams {
  from?: string;
  to?: string;
  limit: number;
  offset: number;
  order: 'asc' | 'desc';
}

export interface Page<T> {
  items: T[];
  total: number;
}

export class CryptocurrencyService {
  private readonly logger: Logger;
  private readonly now: () => Date;

  constructor(
    private readonly cryptoRepo: CryptocurrencyRepository,
    private readonly historyRepo: PriceHistoryRepository,
    private readonly provider: PriceProvider,
    private readonly priceService: PriceService,
    options: { logger?: Logger; now?: () => Date } = {},
  ) {
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? (() => new Date());
  }

  list(limit: number, offset: number): Page<CryptocurrencyWithPrice> {
    return {
      items: this.cryptoRepo.findAll(this.priceService.currency, limit, offset),
      total: this.cryptoRepo.count(),
    };
  }

  get(id: number): CryptocurrencyWithPrice {
    const crypto = this.cryptoRepo.findByIdWithPrice(id, this.priceService.currency);
    if (!crypto) throw new NotFoundError(`Cryptocurrency with id ${id} not found`);
    return crypto;
  }

  /** Starts tracking a cryptocurrency. The symbol is resolved against CoinMarketCap. */
  async create(input: CreateCryptocurrencyInput): Promise<CryptocurrencyWithPrice> {
    if (this.cryptoRepo.findBySymbol(input.symbol)) {
      throw new ConflictError(`Cryptocurrency ${input.symbol} is already tracked`);
    }

    const coin = await this.provider.findBySymbol(input.symbol);
    if (!coin) {
      throw new AppError(422, 'UNKNOWN_SYMBOL', `CoinMarketCap does not know cryptocurrency ${input.symbol}`);
    }

    // Re-check after the await: a concurrent request could have added the same coin
    if (this.cryptoRepo.findBySymbol(input.symbol) || this.cryptoRepo.findByCmcId(coin.cmcId)) {
      throw new ConflictError(`Cryptocurrency ${input.symbol} is already tracked`);
    }

    const created = this.cryptoRepo.create(
      { symbol: input.symbol, name: input.name ?? coin.name, cmcId: coin.cmcId },
      this.now().toISOString(),
    );

    // Best effort: the background job will retry if this fails
    try {
      await this.priceService.sync([created]);
    } catch (error) {
      this.logger.warn('Initial price fetch failed', {
        symbol: created.symbol,
        code: error instanceof AppError ? error.code : 'UNKNOWN',
      });
    }
    return this.get(created.id);
  }

  update(id: number, input: UpdateCryptocurrencyInput): CryptocurrencyWithPrice {
    if (!this.cryptoRepo.updateName(id, input.name, this.now().toISOString())) {
      throw new NotFoundError(`Cryptocurrency with id ${id} not found`);
    }
    return this.get(id);
  }

  delete(id: number): void {
    if (!this.cryptoRepo.delete(id)) throw new NotFoundError(`Cryptocurrency with id ${id} not found`);
  }

  history(id: number, params: HistoryParams): Page<PriceRecord> {
    if (!this.cryptoRepo.findById(id)) throw new NotFoundError(`Cryptocurrency with id ${id} not found`);
    return this.historyRepo.find({ cryptocurrencyId: id, currency: this.priceService.currency, ...params });
  }
}
