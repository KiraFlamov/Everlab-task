import { ValidationError, type ErrorDetail } from '../errors';
import type { CreateCryptocurrencyInput, HistoryParams, UpdateCryptocurrencyInput } from '../services/cryptocurrency.service';

const SYMBOL_RE = /^[A-Z0-9]{1,20}$/;
const ID_RE = /^[1-9]\d{0,15}$/;
const INT_RE = /^\d{1,10}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

export const NAME_MAX_LENGTH = 100;
export const MAX_SYMBOLS_PER_REQUEST = 100;

type Input = Record<string, unknown>;

function isPlainObject(value: unknown): value is Input {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknown(input: Input, allowed: string[], errors: ErrorDetail[], prefix = ''): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) errors.push({ field: `${prefix}${key}`, message: 'Unknown field' });
  }
}

function throwIfAny(errors: ErrorDetail[]): void {
  if (errors.length > 0) throw new ValidationError(errors);
}

function parseSymbol(value: unknown, field: string, errors: ErrorDetail[]): string | undefined {
  if (typeof value !== 'string') {
    errors.push({ field, message: 'Must be a string' });
    return undefined;
  }
  const symbol = value.trim().toUpperCase();
  if (!SYMBOL_RE.test(symbol)) {
    errors.push({ field, message: 'Must contain 1-20 latin letters or digits' });
    return undefined;
  }
  return symbol;
}

function parseName(value: unknown, field: string, errors: ErrorDetail[]): string | undefined {
  if (typeof value !== 'string') {
    errors.push({ field, message: 'Must be a string' });
    return undefined;
  }
  const name = value.trim();
  if (name.length === 0 || name.length > NAME_MAX_LENGTH) {
    errors.push({ field, message: `Must be 1-${NAME_MAX_LENGTH} characters long` });
    return undefined;
  }
  if (CONTROL_CHARS_RE.test(name)) {
    errors.push({ field, message: 'Must not contain control characters' });
    return undefined;
  }
  return name;
}

/** Query values must be single strings (no repeated parameters / nested objects). */
function queryString(query: Input, key: string, errors: ErrorDetail[]): string | undefined {
  const value = query[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    errors.push({ field: key, message: 'Must be specified once' });
    return undefined;
  }
  return value;
}

function parseIntParam(
  query: Input,
  key: string,
  errors: ErrorDetail[],
  { min, max, fallback }: { min: number; max: number; fallback: number },
): number {
  const raw = queryString(query, key, errors);
  if (raw === undefined) return fallback;
  if (!INT_RE.test(raw) || Number(raw) < min || Number(raw) > max) {
    errors.push({ field: key, message: `Must be an integer between ${min} and ${max}` });
    return fallback;
  }
  return Number(raw);
}

function parseDate(query: Input, key: string, errors: ErrorDetail[]): string | undefined {
  const raw = queryString(query, key, errors);
  if (raw === undefined) return undefined;
  const isDate = DATE_RE.test(raw);
  const timestamp = Date.parse(raw);
  // Date-only values must round-trip, otherwise e.g. 2024-02-31 would silently become March 2
  if (
    (!isDate && !DATE_TIME_RE.test(raw)) ||
    Number.isNaN(timestamp) ||
    (isDate && new Date(timestamp).toISOString().slice(0, 10) !== raw)
  ) {
    errors.push({
      field: key,
      message: 'Must be an ISO 8601 date (YYYY-MM-DD) or date-time with timezone (e.g. 2024-01-01T00:00:00Z)',
    });
    return undefined;
  }
  return new Date(timestamp).toISOString();
}

export function parseId(value: unknown): number {
  if (typeof value !== 'string' || !ID_RE.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new ValidationError([{ field: 'id', message: 'Must be a positive integer' }]);
  }
  return Number(value);
}

export function validateCreateCryptocurrency(body: unknown): CreateCryptocurrencyInput {
  if (!isPlainObject(body)) throw new ValidationError([{ message: 'Request body must be a JSON object' }]);
  const errors: ErrorDetail[] = [];
  rejectUnknown(body, ['symbol', 'name'], errors);

  let symbol: string | undefined;
  if (body.symbol === undefined) errors.push({ field: 'symbol', message: 'Is required' });
  else symbol = parseSymbol(body.symbol, 'symbol', errors);

  const name = body.name === undefined ? undefined : parseName(body.name, 'name', errors);
  throwIfAny(errors);
  return { symbol: symbol!, ...(name !== undefined ? { name } : {}) };
}

export function validateUpdateCryptocurrency(body: unknown): UpdateCryptocurrencyInput {
  if (!isPlainObject(body)) throw new ValidationError([{ message: 'Request body must be a JSON object' }]);
  const errors: ErrorDetail[] = [];
  rejectUnknown(body, ['name'], errors);

  let name: string | undefined;
  if (body.name === undefined) errors.push({ field: 'name', message: 'Is required' });
  else name = parseName(body.name, 'name', errors);
  throwIfAny(errors);
  return { name: name! };
}

export function validatePagination(query: Input): { limit: number; offset: number } {
  const errors: ErrorDetail[] = [];
  rejectUnknown(query, ['limit', 'offset'], errors);
  const limit = parseIntParam(query, 'limit', errors, { min: 1, max: 100, fallback: 20 });
  const offset = parseIntParam(query, 'offset', errors, { min: 0, max: 1_000_000_000, fallback: 0 });
  throwIfAny(errors);
  return { limit, offset };
}

export function validateHistoryQuery(query: Input): HistoryParams {
  const errors: ErrorDetail[] = [];
  rejectUnknown(query, ['from', 'to', 'limit', 'offset', 'order'], errors);
  const from = parseDate(query, 'from', errors);
  const to = parseDate(query, 'to', errors);
  const limit = parseIntParam(query, 'limit', errors, { min: 1, max: 1000, fallback: 100 });
  const offset = parseIntParam(query, 'offset', errors, { min: 0, max: 1_000_000_000, fallback: 0 });

  const order = queryString(query, 'order', errors) ?? 'desc';
  if (order !== 'asc' && order !== 'desc') errors.push({ field: 'order', message: 'Must be "asc" or "desc"' });
  if (from && to && from > to) errors.push({ field: 'from', message: 'Must not be later than "to"' });
  throwIfAny(errors);

  return {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    limit,
    offset,
    order: order as 'asc' | 'desc',
  };
}

export function validatePricesQuery(query: Input): { symbols?: string[] } {
  const errors: ErrorDetail[] = [];
  rejectUnknown(query, ['symbols'], errors);
  const raw = queryString(query, 'symbols', errors);
  throwIfAny(errors);
  if (raw === undefined) return {};

  const symbols = new Set<string>();
  for (const part of raw.split(',')) {
    const symbol = parseSymbol(part, 'symbols', errors);
    if (symbol) symbols.add(symbol);
  }
  if (symbols.size > MAX_SYMBOLS_PER_REQUEST) {
    errors.push({ field: 'symbols', message: `At most ${MAX_SYMBOLS_PER_REQUEST} symbols are allowed` });
  }
  throwIfAny(errors);
  return { symbols: [...symbols] };
}
