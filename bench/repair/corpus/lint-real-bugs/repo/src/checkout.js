import { couponPercent } from './coupon.js';
import { parsePrice } from './price.js';
import { shippingFor } from './shipping.js';

/** An order's total in cents: its prices as typed, less the coupon's percentage (rounded to the cent), plus shipping. */
export function orderTotal({ prices, coupon = '', region }) {
  const subtotal = prices.reduce((sum, price) => sum + parsePrice(price), 0);
  const discount = Math.round((subtotal * couponPercent(coupon)) / 100);
  return subtotal - discount + shippingFor(region);
}
