import path from 'node:path';
import { ConfigError, loadConfig } from '../src/config';
import { migrate, openDatabase } from '../src/db/database';

const base = { API_KEY: 'a'.repeat(32), CMC_API_KEY: 'cmc-key' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig(base);

    expect(config).toMatchObject({
      port: 3000,
      apiKeyReadonly: null,
      priceCurrency: 'USD',
      priceMaxAgeMs: 60_000,
      sync: { enabled: true, intervalMs: 300_000 },
      cmc: { apiKey: 'cmc-key', baseUrl: 'https://pro-api.coinmarketcap.com', timeoutMs: 10_000, maxRetries: 2 },
      logLevel: 'info',
    });
    expect(config.dbPath).toBe(path.resolve('./data/app.db'));
  });

  it('reads overrides', () => {
    const config = loadConfig({
      ...base,
      PORT: '8080',
      API_KEY_READONLY: 'r'.repeat(32),
      PRICE_CURRENCY: 'eur',
      SYNC_ENABLED: 'false',
      SYNC_INTERVAL_MS: '30000',
      CMC_BASE_URL: 'https://sandbox-api.coinmarketcap.com/',
      LOG_LEVEL: 'DEBUG',
    });

    expect(config).toMatchObject({
      port: 8080,
      apiKeyReadonly: 'r'.repeat(32),
      priceCurrency: 'EUR',
      sync: { enabled: false, intervalMs: 30_000 },
      cmc: { baseUrl: 'https://sandbox-api.coinmarketcap.com' },
      logLevel: 'debug',
    });
  });

  it.each([
    [{ CMC_API_KEY: 'x' }, /API_KEY is required/],
    [{ API_KEY: 'a'.repeat(32) }, /CMC_API_KEY is required/],
    [{ ...base, API_KEY: 'short' }, /at least 16/],
    [{ ...base, API_KEY_READONLY: base.API_KEY }, /must differ/],
    [{ ...base, PORT: 'abc' }, /PORT/],
    [{ ...base, SYNC_INTERVAL_MS: '10' }, /SYNC_INTERVAL_MS/],
    [{ ...base, SYNC_ENABLED: 'maybe' }, /SYNC_ENABLED/],
    [{ ...base, PRICE_CURRENCY: 'US$' }, /PRICE_CURRENCY/],
    [{ ...base, LOG_LEVEL: 'verbose' }, /LOG_LEVEL/],
  ])('rejects invalid environment %j', (env, message) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(message);
  });
});

describe('database', () => {
  it('creates the schema and is safe to migrate repeatedly', () => {
    const db = openDatabase(':memory:');
    migrate(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all();
    expect(tables).toEqual([{ name: 'cryptocurrencies' }, { name: 'price_history' }]);
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('enforces constraints at the database level', () => {
    const db = openDatabase(':memory:');
    const insert = db.prepare(
      "INSERT INTO cryptocurrencies (symbol, name, cmc_id, created_at, updated_at) VALUES (?, ?, ?, 'now', 'now')",
    );
    insert.run('BTC', 'Bitcoin', 1);

    expect(() => insert.run('BTC', 'Other', 2)).toThrow(/UNIQUE/);
    expect(() =>
      db
        .prepare("INSERT INTO price_history (cryptocurrency_id, price, currency, fetched_at) VALUES (999, 1, 'USD', 'now')")
        .run(),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      db
        .prepare("INSERT INTO price_history (cryptocurrency_id, price, currency, fetched_at) VALUES (1, -1, 'USD', 'now')")
        .run(),
    ).toThrow(/CHECK/);
    db.close();
  });
});
