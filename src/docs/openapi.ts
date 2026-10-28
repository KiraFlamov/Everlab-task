const errorResponse = (description: string, example: { code: string; message: string }) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { error: example } } },
});

const responses = {
  BadRequest: errorResponse('Invalid input', { code: 'VALIDATION_ERROR', message: 'Request validation failed' }),
  Unauthorized: errorResponse('Missing or invalid API key', { code: 'UNAUTHORIZED', message: 'Invalid API key' }),
  Forbidden: errorResponse('The API key has read-only access', {
    code: 'FORBIDDEN',
    message: 'This API key has read-only access',
  }),
  NotFound: errorResponse('Resource not found', { code: 'NOT_FOUND', message: 'Cryptocurrency with id 1 not found' }),
  BadGateway: errorResponse('CoinMarketCap returned an error (bad API key, unexpected response, ...)', {
    code: 'EXTERNAL_API_UNAUTHORIZED',
    message: 'CoinMarketCap rejected the API key or the plan does not allow this request',
  }),
  ServiceUnavailable: {
    ...errorResponse('CoinMarketCap is temporarily unavailable (timeout, network error, rate limit, 5xx)', {
      code: 'EXTERNAL_API_TIMEOUT',
      message: 'CoinMarketCap request timed out',
    }),
    headers: { 'Retry-After': { schema: { type: 'integer' }, description: 'Seconds to wait before retrying' } },
  },
};

const idParam = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'Tracked cryptocurrency id',
  schema: { type: 'integer', minimum: 1 },
};

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Crypto Price Tracker API',
    version: '1.0.0',
    description:
      'Tracking and aggregation of cryptocurrency prices using the CoinMarketCap API.\n\n' +
      'All `/api/v1` endpoints require `Authorization: Bearer <API key>`. ' +
      'The read-only key (`API_KEY_READONLY`) may call only GET endpoints.\n\n' +
      'All prices are returned in a single application-wide currency (`PRICE_CURRENCY`, USD by default). ' +
      'Timestamps are ISO 8601 in UTC.',
  },
  servers: [{ url: '/' }],
  tags: [
    { name: 'Cryptocurrencies', description: 'Managing the list of tracked cryptocurrencies' },
    { name: 'Prices', description: 'Current prices and price history' },
    { name: 'System' },
  ],
  security: [{ bearerAuth: [] }],
  paths: {
    '/health': {
      get: {
        tags: ['System'],
        summary: 'Liveness/readiness check',
        security: [],
        responses: {
          200: {
            description: 'Service is healthy',
            content: { 'application/json': { example: { status: 'ok' } } },
          },
          503: { description: 'Database is unavailable' },
        },
      },
    },
    '/docs/': {
      get: {
        tags: ['System'],
        summary: 'Swagger UI',
        description: '`/docs` redirects here (301).',
        security: [],
        responses: {
          200: { description: 'Interactive API documentation', content: { 'text/html': {} } },
        },
      },
    },
    '/docs/openapi.json': {
      get: {
        tags: ['System'],
        summary: 'This OpenAPI 3.0 document',
        security: [],
        responses: {
          200: {
            description: 'OpenAPI document',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
    '/api/v1/cryptocurrencies': {
      get: {
        tags: ['Cryptocurrencies'],
        summary: 'List tracked cryptocurrencies',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
        ],
        responses: {
          200: {
            description: 'Page of tracked cryptocurrencies ordered by symbol',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['data', 'pagination'],
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/Cryptocurrency' } },
                    pagination: { $ref: '#/components/schemas/Pagination' },
                  },
                },
              },
            },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
      post: {
        tags: ['Cryptocurrencies'],
        summary: 'Start tracking a cryptocurrency',
        description:
          'The symbol is resolved via CoinMarketCap (`/v1/cryptocurrency/map`). If several coins share the symbol, ' +
          'the highest ranked active one is chosen. The initial price is fetched immediately (best effort).',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateCryptocurrency' },
              example: { symbol: 'BTC' },
            },
          },
        },
        responses: {
          201: {
            description: 'Cryptocurrency is now tracked',
            headers: { Location: { schema: { type: 'string' } } },
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { data: { $ref: '#/components/schemas/Cryptocurrency' } },
                },
              },
            },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          409: errorResponse('Already tracked', { code: 'CONFLICT', message: 'Cryptocurrency BTC is already tracked' }),
          422: errorResponse('Unknown symbol', {
            code: 'UNKNOWN_SYMBOL',
            message: 'CoinMarketCap does not know cryptocurrency XXX',
          }),
          502: { $ref: '#/components/responses/BadGateway' },
          503: { $ref: '#/components/responses/ServiceUnavailable' },
        },
      },
    },
    '/api/v1/cryptocurrencies/{id}': {
      parameters: [idParam],
      get: {
        tags: ['Cryptocurrencies'],
        summary: 'Get a tracked cryptocurrency',
        responses: {
          200: {
            description: 'Tracked cryptocurrency with its latest stored price',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/Cryptocurrency' } } },
              },
            },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
      patch: {
        tags: ['Cryptocurrencies'],
        summary: 'Update a tracked cryptocurrency',
        description: 'Only the display name can be changed; the symbol is bound to the CoinMarketCap id.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/UpdateCryptocurrency' },
              example: { name: 'Bitcoin (BTC)' },
            },
          },
        },
        responses: {
          200: {
            description: 'Updated cryptocurrency',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/Cryptocurrency' } } },
              },
            },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
      delete: {
        tags: ['Cryptocurrencies'],
        summary: 'Stop tracking a cryptocurrency',
        description: 'Deletes the cryptocurrency together with its price history.',
        responses: {
          204: { description: 'Deleted' },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/api/v1/cryptocurrencies/{id}/history': {
      parameters: [idParam],
      get: {
        tags: ['Prices'],
        summary: 'Price history of a cryptocurrency',
        parameters: [
          {
            name: 'from',
            in: 'query',
            description: 'Inclusive lower bound: `YYYY-MM-DD` or ISO date-time with timezone (encode `+` as `%2B`)',
            schema: { type: 'string', example: '2024-01-01T00:00:00Z' },
          },
          {
            name: 'to',
            in: 'query',
            description: 'Inclusive upper bound, same format as `from`',
            schema: { type: 'string', example: '2024-12-31' },
          },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000, default: 100 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
          { name: 'order', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' } },
        ],
        responses: {
          200: {
            description: 'Page of price records',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/PriceHistory' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/api/v1/prices': {
      get: {
        tags: ['Prices'],
        summary: 'Current prices of tracked cryptocurrencies',
        description:
          'Prices older than `PRICE_MAX_AGE_MS` are refreshed from CoinMarketCap and saved to the history before ' +
          'responding. If CoinMarketCap is unavailable, the last stored prices are returned with `stale: true` and ' +
          'a `warning`; if there are no stored prices at all, the upstream error (502/503) is returned.',
        parameters: [
          {
            name: 'symbols',
            in: 'query',
            description: 'Comma-separated list of tracked symbols (all tracked when omitted)',
            schema: { type: 'string', example: 'BTC,ETH' },
          },
        ],
        responses: {
          200: {
            description: 'Latest prices',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/LatestPrices' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: errorResponse('Some of the requested symbols are not tracked', {
            code: 'NOT_FOUND',
            message: 'Cryptocurrencies are not tracked: DOGE',
          }),
          502: { $ref: '#/components/responses/BadGateway' },
          503: { $ref: '#/components/responses/ServiceUnavailable' },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', description: 'API key passed as a Bearer token' },
    },
    responses,
    schemas: {
      Error: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: { type: 'string', example: 'VALIDATION_ERROR' },
              message: { type: 'string' },
              details: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['message'],
                  properties: { field: { type: 'string' }, message: { type: 'string' } },
                },
              },
            },
          },
        },
      },
      Pagination: {
        type: 'object',
        required: ['limit', 'offset', 'total'],
        properties: { limit: { type: 'integer' }, offset: { type: 'integer' }, total: { type: 'integer' } },
      },
      Cryptocurrency: {
        type: 'object',
        required: ['id', 'symbol', 'name', 'cmcId', 'latestPrice', 'createdAt', 'updatedAt'],
        properties: {
          id: { type: 'integer', example: 1 },
          symbol: { type: 'string', example: 'BTC' },
          name: { type: 'string', example: 'Bitcoin' },
          cmcId: { type: 'integer', description: 'CoinMarketCap id', example: 1 },
          latestPrice: {
            type: 'object',
            nullable: true,
            required: ['value', 'currency', 'fetchedAt'],
            properties: {
              value: { type: 'number', example: 67123.45 },
              currency: { type: 'string', example: 'USD' },
              fetchedAt: { type: 'string', format: 'date-time' },
            },
          },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: {
            type: 'string',
            format: 'date-time',
            description: 'Last update of the record (name change or price synchronization)',
          },
        },
      },
      CreateCryptocurrency: {
        type: 'object',
        required: ['symbol'],
        additionalProperties: false,
        properties: {
          symbol: { type: 'string', pattern: '^[A-Za-z0-9]{1,20}$', example: 'BTC', description: 'Case-insensitive' },
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 100,
            description: 'Display name; defaults to the CoinMarketCap name',
          },
        },
      },
      UpdateCryptocurrency: {
        type: 'object',
        required: ['name'],
        additionalProperties: false,
        properties: { name: { type: 'string', minLength: 1, maxLength: 100 } },
      },
      PriceHistory: {
        type: 'object',
        required: ['cryptocurrency', 'currency', 'data', 'pagination'],
        properties: {
          cryptocurrency: {
            type: 'object',
            properties: { id: { type: 'integer' }, symbol: { type: 'string' }, name: { type: 'string' } },
          },
          currency: { type: 'string', example: 'USD' },
          data: {
            type: 'array',
            items: {
              type: 'object',
              required: ['price', 'fetchedAt', 'sourceUpdatedAt'],
              properties: {
                price: { type: 'number', example: 67123.45 },
                fetchedAt: { type: 'string', format: 'date-time', description: 'When the price was fetched' },
                sourceUpdatedAt: {
                  type: 'string',
                  format: 'date-time',
                  nullable: true,
                  description: 'CoinMarketCap last_updated of the quote',
                },
              },
            },
          },
          pagination: { $ref: '#/components/schemas/Pagination' },
        },
      },
      LatestPrices: {
        type: 'object',
        required: ['currency', 'data'],
        properties: {
          currency: { type: 'string', example: 'USD' },
          data: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'symbol', 'name', 'price', 'fetchedAt', 'stale'],
              properties: {
                id: { type: 'integer' },
                symbol: { type: 'string', example: 'BTC' },
                name: { type: 'string', example: 'Bitcoin' },
                price: { type: 'number', nullable: true, example: 67123.45 },
                fetchedAt: { type: 'string', format: 'date-time', nullable: true },
                stale: { type: 'boolean', description: 'Price is older than PRICE_MAX_AGE_MS or absent' },
              },
            },
          },
          warning: {
            type: 'string',
            description: 'Present when stored prices were served because CoinMarketCap is unavailable',
          },
        },
      },
    },
  },
};
