import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

/**
 * Schema migrations, applied in order. The index + 1 is stored in PRAGMA user_version,
 * so new migrations must only ever be appended.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE cryptocurrencies (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol      TEXT    NOT NULL UNIQUE,
    name        TEXT    NOT NULL,
    cmc_id      INTEGER NOT NULL UNIQUE,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
  );

  CREATE TABLE price_history (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    cryptocurrency_id  INTEGER NOT NULL REFERENCES cryptocurrencies(id) ON DELETE CASCADE,
    price              REAL    NOT NULL CHECK (price >= 0),
    currency           TEXT    NOT NULL,
    fetched_at         TEXT    NOT NULL,
    source_updated_at  TEXT
  );

  CREATE INDEX idx_price_history_crypto_time
    ON price_history (cryptocurrency_id, currency, fetched_at);
  `,
];

export function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}

/** Opens (creating if needed) the SQLite database and applies migrations. Use ':memory:' in tests. */
export function openDatabase(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}
