import { createApplication } from './app';
import { CoinMarketCapClient } from './clients/coinmarketcap.client';
import { ConfigError, loadConfig, loadEnvFile } from './config';
import { openDatabase } from './db/database';
import { PriceSyncJob } from './jobs/price-sync.job';
import { createShutdown, registerSignalHandlers } from './lifecycle';
import { createLogger } from './utils/logger';

function main(): void {
  loadEnvFile();
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const db = openDatabase(config.dbPath);
  const priceProvider = new CoinMarketCapClient({ ...config.cmc, logger });
  const requestsAbortController = new AbortController();
  const { app, priceService } = createApplication({
    db,
    priceProvider,
    apiKey: config.apiKey,
    apiKeyReadonly: config.apiKeyReadonly,
    currency: config.priceCurrency,
    priceMaxAgeMs: config.priceMaxAgeMs,
    shutdownSignal: requestsAbortController.signal,
    logger,
  });

  const job = config.sync.enabled ? new PriceSyncJob(priceService, { intervalMs: config.sync.intervalMs, logger }) : null;

  const server = app.listen(config.port, () => {
    logger.info('Server listening', { port: config.port, currency: config.priceCurrency, docs: '/docs' });
    job?.start();
  });
  server.on('error', (error) => {
    logger.error('HTTP server error', { error: error.message });
    process.exit(1);
  });

  registerSignalHandlers(createShutdown({ server, job, db, requestsAbortController, logger }));
}

try {
  main();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`Configuration error: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
