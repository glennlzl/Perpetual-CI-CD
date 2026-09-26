import { check } from '../../util/assert.js';
import { ok } from '../respond.js';

/** POST /quotes prices { region, lines: [{ sku, qty }], code? } without placing an order. */
export const quoteRoutes = ({ quotes }) => ({
  'POST /quotes': ({ body }) => {
    check(body !== null && typeof body === 'object', 'send the quote request as a JSON object');
    return ok({ quote: quotes.quote(body) });
  },
});
