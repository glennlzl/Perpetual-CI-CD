import { check } from '../../util/assert.js';
import { created, ok } from '../respond.js';

/** POST /orders places { region, lines: [{ sku, qty }], code? }; GET /orders/:id reads a placed order. */
export const orderRoutes = ({ orders }) => ({
  'POST /orders': ({ body }) => {
    check(body !== null && typeof body === 'object', 'send the order as a JSON object');
    return created({ order: orders.place(body) });
  },
  'GET /orders/:id': ({ params }) => ok({ order: orders.get(params.id) }),
});
