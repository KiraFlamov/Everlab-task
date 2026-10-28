import { Router } from 'express';
import type { CryptocurrencyWithPrice } from '../repositories/cryptocurrency.repository';
import type { CryptocurrencyService } from '../services/cryptocurrency.service';
import {
  parseId,
  validateCreateCryptocurrency,
  validateHistoryQuery,
  validatePagination,
  validateUpdateCryptocurrency,
} from '../validation/validators';

function present(crypto: CryptocurrencyWithPrice, currency: string) {
  return {
    id: crypto.id,
    symbol: crypto.symbol,
    name: crypto.name,
    cmcId: crypto.cmcId,
    latestPrice:
      crypto.price === null ? null : { value: crypto.price, currency, fetchedAt: crypto.priceFetchedAt },
    createdAt: crypto.createdAt,
    updatedAt: crypto.updatedAt,
  };
}

export function cryptocurrenciesRouter(service: CryptocurrencyService, currency: string): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const { limit, offset } = validatePagination(req.query);
    const { items, total } = service.list(limit, offset);
    res.json({ data: items.map((c) => present(c, currency)), pagination: { limit, offset, total } });
  });

  router.post('/', async (req, res) => {
    const input = validateCreateCryptocurrency(req.body);
    const created = await service.create(input);
    res.status(201).location(`${req.baseUrl}/${created.id}`).json({ data: present(created, currency) });
  });

  router.get('/:id', (req, res) => {
    res.json({ data: present(service.get(parseId(req.params.id)), currency) });
  });

  router.patch('/:id', (req, res) => {
    const id = parseId(req.params.id);
    const input = validateUpdateCryptocurrency(req.body);
    res.json({ data: present(service.update(id, input), currency) });
  });

  router.delete('/:id', (req, res) => {
    service.delete(parseId(req.params.id));
    res.status(204).end();
  });

  router.get('/:id/history', (req, res) => {
    const id = parseId(req.params.id);
    const params = validateHistoryQuery(req.query);
    const crypto = service.get(id);
    const { items, total } = service.history(id, params);
    res.json({
      cryptocurrency: { id: crypto.id, symbol: crypto.symbol, name: crypto.name },
      currency,
      data: items.map((p) => ({ price: p.price, fetchedAt: p.fetchedAt, sourceUpdatedAt: p.sourceUpdatedAt })),
      pagination: { limit: params.limit, offset: params.offset, total },
    });
  });

  return router;
}
