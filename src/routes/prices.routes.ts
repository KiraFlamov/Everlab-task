import { Router } from 'express';
import type { PriceService } from '../services/price.service';
import { validatePricesQuery } from '../validation/validators';

export function pricesRouter(priceService: PriceService): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const { symbols } = validatePricesQuery(req.query);
    res.json(await priceService.getLatest(symbols));
  });

  return router;
}
