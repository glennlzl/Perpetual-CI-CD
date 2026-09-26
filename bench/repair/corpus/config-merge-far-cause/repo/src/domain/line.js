import { check } from '../util/assert.js';
import { isCents } from './money.js';

/** The most of one product an order line takes. */
export const MAX_QTY = 99;

/** An order line: qty (1 to 99) of a catalog product at its current price. */
export function createLine(product, qty) {
  check(Number.isInteger(qty) && qty >= 1 && qty <= MAX_QTY, `qty of ${product.sku} must be a whole number from 1 to ${MAX_QTY}`);
  check(isCents(product.unitCents), `${product.sku} has no price`);
  return { sku: product.sku, name: product.name, qty, unitCents: product.unitCents, lineCents: qty * product.unitCents };
}
