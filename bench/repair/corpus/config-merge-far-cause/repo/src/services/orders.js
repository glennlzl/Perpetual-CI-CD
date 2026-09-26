import { createOrder } from '../domain/order.js';
import { notFound } from '../util/assert.js';

/** Orders: placing one prices it as a quote, then keeps it. */
export function createOrders({ quotes, store, clock, ids }) {
  return {
    place(request) {
      const { region, code, lines, totals } = quotes.quote(request);
      const order = createOrder({ id: ids('ord'), placedAt: clock.now(), region, code, lines, totals });
      store.orders.save(order);
      return order;
    },
    get: id => store.orders.get(id) ?? notFound(`No order ${id}.`),
  };
}
