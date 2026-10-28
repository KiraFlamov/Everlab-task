import { Router } from 'express';
import type { PriceService } from '../services/price.service';
import { validatePricesQuery } from '../validation/validators';

/** `signal` aborts in-flight CoinMarketCap requests on shutdown. */
export function pricesRouter(priceService: PriceService, signal?: AbortSignal): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const { symbols } = validatePricesQuery(req.query);
    res.json(await priceService.getLatest(symbols, signal));
  });

  return router;
}
