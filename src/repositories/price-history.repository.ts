import type { Db } from '../db/database';

export interface PriceRecord {
  id: number;
  cryptocurrencyId: number;
  price: number;
  currency: string;
  fetchedAt: string;
  sourceUpdatedAt: string | null;
}

export interface NewPriceRecord {
  cryptocurrencyId: number;
  price: number;
  sourceUpdatedAt: string | null;
}

export interface HistoryQuery {
  cryptocurrencyId: number;
  currency: string;
  from?: string;
  to?: string;
  limit: number;
  offset: number;
  order: 'asc' | 'desc';
}

interface PriceRow {
  id: number;
  cryptocurrency_id: number;
  price: number;
  currency: string;
  fetched_at: string;
  source_updated_at: string | null;
}

const toEntity = (row: PriceRow): PriceRecord => ({
  id: row.id,
  cryptocurrencyId: row.cryptocurrency_id,
  price: row.price,
  currency: row.currency,
  fetchedAt: row.fetched_at,
  sourceUpdatedAt: row.source_updated_at,
});

export class PriceHistoryRepository {
  constructor(private readonly db: Db) {}

  insertMany(records: NewPriceRecord[], currency: string, fetchedAt: string): void {
    const stmt = this.db.prepare(
      `INSERT INTO price_history (cryptocurrency_id, price, currency, fetched_at, source_updated_at)
       VALUES (@cryptocurrencyId, @price, @currency, @fetchedAt, @sourceUpdatedAt)`,
    );
    for (const record of records) stmt.run({ ...record, currency, fetchedAt });
  }

  find(query: HistoryQuery): { items: PriceRecord[]; total: number } {
    const conditions = ['cryptocurrency_id = @cryptocurrencyId', 'currency = @currency'];
    if (query.from) conditions.push('fetched_at >= @from');
    if (query.to) conditions.push('fetched_at <= @to');
    const where = conditions.join(' AND ');
    const params = { from: null, to: null, ...query };
    // Direction is taken from a validated enum, never from raw input
    const direction = query.order === 'asc' ? 'ASC' : 'DESC';

    const items = this.db
      .prepare(
        `SELECT * FROM price_history WHERE ${where}
         ORDER BY fetched_at ${direction}, id ${direction}
         LIMIT @limit OFFSET @offset`,
      )
      .all(params) as PriceRow[];
    const { total } = this.db.prepare(`SELECT COUNT(*) AS total FROM price_history WHERE ${where}`).get(params) as {
      total: number;
    };
    return { items: items.map(toEntity), total };
  }
}
