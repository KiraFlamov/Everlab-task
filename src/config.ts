import fs from 'node:fs';
import path from 'node:path';
import type { LogLevel } from './utils/logger';

export interface AppConfig {
  port: number;
  apiKey: string;
  apiKeyReadonly: string | null;
  cmc: {
    apiKey: string;
    baseUrl: string;
    timeoutMs: number;
    maxRetries: number;
    retryBaseDelayMs: number;
  };
  priceCurrency: string;
  priceMaxAgeMs: number;
  sync: {
    enabled: boolean;
    intervalMs: number;
  };
  dbPath: string;
  logLevel: LogLevel;
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

function readString(env: Env, name: string, fallback?: string): string {
  const value = env[name]?.trim();
  if (value) return value;
  if (fallback !== undefined) return fallback;
  throw new ConfigError(`Environment variable ${name} is required`);
}

function readInt(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be a non-negative integer`);
  const value = Number(raw);
  if (value < min || value > max) throw new ConfigError(`${name} must be between ${min} and ${max}`);
  return value;
}

function readBool(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['true', '1', 'yes'].includes(raw)) return true;
  if (['false', '0', 'no'].includes(raw)) return false;
  throw new ConfigError(`${name} must be a boolean (true/false)`);
}

export function loadConfig(env: Env = process.env): AppConfig {
  const apiKey = readString(env, 'API_KEY');
  if (apiKey.length < 16) throw new ConfigError('API_KEY must be at least 16 characters long');

  const apiKeyReadonly = env.API_KEY_READONLY?.trim() || null;
  if (apiKeyReadonly !== null && apiKeyReadonly.length < 16) {
    throw new ConfigError('API_KEY_READONLY must be at least 16 characters long');
  }
  if (apiKeyReadonly === apiKey) throw new ConfigError('API_KEY_READONLY must differ from API_KEY');

  const priceCurrency = readString(env, 'PRICE_CURRENCY', 'USD').toUpperCase();
  if (!/^[A-Z]{3,5}$/.test(priceCurrency)) throw new ConfigError('PRICE_CURRENCY must be a currency code, e.g. USD');

  const logLevel = readString(env, 'LOG_LEVEL', 'info').toLowerCase();
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    throw new ConfigError('LOG_LEVEL must be one of debug, info, warn, error');
  }

  return {
    port: readInt(env, 'PORT', 3000, 0, 65535),
    apiKey,
    apiKeyReadonly,
    cmc: {
      apiKey: readString(env, 'CMC_API_KEY'),
      baseUrl: readString(env, 'CMC_BASE_URL', 'https://pro-api.coinmarketcap.com').replace(/\/+$/, ''),
      timeoutMs: readInt(env, 'CMC_TIMEOUT_MS', 10_000, 100, 120_000),
      maxRetries: readInt(env, 'CMC_MAX_RETRIES', 2, 0, 10),
      retryBaseDelayMs: readInt(env, 'CMC_RETRY_BASE_DELAY_MS', 500, 0, 60_000),
    },
    priceCurrency,
    priceMaxAgeMs: readInt(env, 'PRICE_MAX_AGE_MS', 60_000, 0, 86_400_000),
    sync: {
      enabled: readBool(env, 'SYNC_ENABLED', true),
      // 5 min keeps the job within the CoinMarketCap Basic plan (10k credits/month)
      intervalMs: readInt(env, 'SYNC_INTERVAL_MS', 300_000, 1_000, 86_400_000),
    },
    dbPath: path.resolve(readString(env, 'DB_PATH', './data/app.db')),
    logLevel: logLevel as LogLevel,
  };
}

/** Loads variables from a local .env file (if present) using Node's built-in loader. */
export function loadEnvFile(file = '.env'): void {
  if (fs.existsSync(file)) process.loadEnvFile(file);
}
