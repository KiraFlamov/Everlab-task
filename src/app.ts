import express, { type Express } from 'express';
import swaggerUi from 'swagger-ui-express';
import type { PriceProvider } from './clients/coinmarketcap.client';
import type { Db } from './db/database';
import { openApiSpec } from './docs/openapi';
import { authenticate } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { CryptocurrencyRepository } from './repositories/cryptocurrency.repository';
import { PriceHistoryRepository } from './repositories/price-history.repository';
import { cryptocurrenciesRouter } from './routes/cryptocurrencies.routes';
import { pricesRouter } from './routes/prices.routes';
import { CryptocurrencyService } from './services/cryptocurrency.service';
import { PriceService } from './services/price.service';
import { silentLogger, type Logger } from './utils/logger';

export interface AppDependencies {
  db: Db;
  priceProvider: PriceProvider;
  apiKey: string;
  apiKeyReadonly?: string | null;
  currency: string;
  priceMaxAgeMs: number;
  logger?: Logger;
  now?: () => Date;
}

export interface Application {
  app: Express;
  priceService: PriceService;
  cryptocurrencyService: CryptocurrencyService;
}

/** Wires repositories, services and routes. All external dependencies are injected for testability. */
export function createApplication(deps: AppDependencies): Application {
  const logger = deps.logger ?? silentLogger;
  const cryptoRepo = new CryptocurrencyRepository(deps.db);
  const historyRepo = new PriceHistoryRepository(deps.db);
  const priceService = new PriceService(deps.db, cryptoRepo, historyRepo, deps.priceProvider, {
    currency: deps.currency,
    maxAgeMs: deps.priceMaxAgeMs,
    logger,
    now: deps.now,
  });
  const cryptocurrencyService = new CryptocurrencyService(cryptoRepo, historyRepo, deps.priceProvider, priceService, {
    logger,
    now: deps.now,
  });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb', strict: true }));

  app.get('/health', (_req, res) => {
    try {
      deps.db.prepare('SELECT 1').get();
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'error', error: { code: 'DATABASE_UNAVAILABLE', message: 'Database is unavailable' } });
    }
  });

  app.get('/docs/openapi.json', (_req, res) => {
    res.json(openApiSpec);
  });
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec, { customSiteTitle: 'Crypto Price Tracker API' }));

  const api = express.Router();
  api.use(authenticate({ full: deps.apiKey, readonly: deps.apiKeyReadonly ?? null }));
  api.use('/cryptocurrencies', cryptocurrenciesRouter(cryptocurrencyService, deps.currency));
  api.use('/prices', pricesRouter(priceService));
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler(logger));

  return { app, priceService, cryptocurrencyService };
}
