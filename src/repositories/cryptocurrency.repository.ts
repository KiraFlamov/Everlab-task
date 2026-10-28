import type { Db } from '../db/database';

export interface Cryptocurrency {
  id: number;
  symbol: string;
  name: string;
  cmcId: number;
  createdAt: string;
  updatedAt: string;
}

export interface CryptocurrencyWithPrice extends Cryptocurrency {
  price: number | null;
  priceFetchedAt: string | null;
}

interface CryptocurrencyRow {
  id: number;
  symbol: string;
  name: string;
  cmc_id: number;
  created_at: string;
  updated_at: string;
}

interface CryptocurrencyWithPriceRow extends CryptocurrencyRow {
  price: number | null;
  price_fetched_at: string | null;
}

const toEntity = (row: CryptocurrencyRow): Cryptocurrency => ({
  id: row.id,
  symbol: row.symbol,
  name: row.name,
  cmcId: row.cmc_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toEntityWithPrice = (row: CryptocurrencyWithPriceRow): CryptocurrencyWithPrice => ({
  ...toEntity(row),
  price: row.price,
  priceFetchedAt: row.price_fetched_at,
});

// Latest price per cryptocurrency in the given currency (served by idx_price_history_crypto_time)
const SELECT_WITH_LATEST_PRICE = `
  SELECT c.*, ph.price AS price, ph.fetched_at AS price_fetched_at
  FROM cryptocurrencies c
  LEFT JOIN price_history ph ON ph.id = (
    SELECT id FROM price_history
    WHERE cryptocurrency_id = c.id AND currency = @currency
    ORDER BY fetched_at DESC, id DESC
    LIMIT 1
  )`;

export class CryptocurrencyRepository {
  constructor(private readonly db: Db) {}

  findAll(currency: string, limit: number, offset: number): CryptocurrencyWithPrice[] {
    const rows = this.db
      .prepare(`${SELECT_WITH_LATEST_PRICE} ORDER BY c.symbol LIMIT @limit OFFSET @offset`)
      .all({ currency, limit, offset }) as CryptocurrencyWithPriceRow[];
    return rows.map(toEntityWithPrice);
  }

  findAllWithPrice(currency: string): CryptocurrencyWithPrice[] {
    const rows = this.db
      .prepare(`${SELECT_WITH_LATEST_PRICE} ORDER BY c.symbol`)
      .all({ currency }) as CryptocurrencyWithPriceRow[];
    return rows.map(toEntityWithPrice);
  }

  findBySymbolsWithPrice(symbols: string[], currency: string): CryptocurrencyWithPrice[] {
    if (symbols.length === 0) return [];
    const params: Record<string, string> = { currency };
    const placeholders = symbols.map((symbol, i) => {
      params[`s${i}`] = symbol;
      return `@s${i}`;
    });
    const rows = this.db
      .prepare(`${SELECT_WITH_LATEST_PRICE} WHERE c.symbol IN (${placeholders.join(', ')}) ORDER BY c.symbol`)
      .all(params) as CryptocurrencyWithPriceRow[];
    return rows.map(toEntityWithPrice);
  }

  findByIdWithPrice(id: number, currency: string): CryptocurrencyWithPrice | null {
    const row = this.db.prepare(`${SELECT_WITH_LATEST_PRICE} WHERE c.id = @id`).get({ id, currency }) as
      | CryptocurrencyWithPriceRow
      | undefined;
    return row ? toEntityWithPrice(row) : null;
  }

  findById(id: number): Cryptocurrency | null {
    const row = this.db.prepare('SELECT * FROM cryptocurrencies WHERE id = ?').get(id) as CryptocurrencyRow | undefined;
    return row ? toEntity(row) : null;
  }

  findBySymbol(symbol: string): Cryptocurrency | null {
    const row = this.db.prepare('SELECT * FROM cryptocurrencies WHERE symbol = ?').get(symbol) as
      | CryptocurrencyRow
      | undefined;
    return row ? toEntity(row) : null;
  }

  findByCmcId(cmcId: number): Cryptocurrency | null {
    const row = this.db.prepare('SELECT * FROM cryptocurrencies WHERE cmc_id = ?').get(cmcId) as
      | CryptocurrencyRow
      | undefined;
    return row ? toEntity(row) : null;
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS total FROM cryptocurrencies').get() as { total: number }).total;
  }

  create(data: { symbol: string; name: string; cmcId: number }, now: string): Cryptocurrency {
    const result = this.db
      .prepare(
        `INSERT INTO cryptocurrencies (symbol, name, cmc_id, created_at, updated_at)
         VALUES (@symbol, @name, @cmcId, @now, @now)`,
      )
      .run({ ...data, now });
    return this.findById(Number(result.lastInsertRowid))!;
  }

  updateName(id: number, name: string, now: string): boolean {
    const result = this.db
      .prepare('UPDATE cryptocurrencies SET name = @name, updated_at = @now WHERE id = @id')
      .run({ id, name, now });
    return result.changes > 0;
  }

  touch(ids: number[], now: string): void {
    const stmt = this.db.prepare('UPDATE cryptocurrencies SET updated_at = ? WHERE id = ?');
    for (const id of ids) stmt.run(now, id);
  }

  delete(id: number): boolean {
    return this.db.prepare('DELETE FROM cryptocurrencies WHERE id = ?').run(id).changes > 0;
  }
}
