import { DEFAULT_CURRENCY, formatMoney } from '../domain/money.js';
import { discountCents } from './discounts.js';
import { shippingCents } from './shipping.js';
import { taxCents } from './tax.js';

/**
 * The totals of priced lines in a region, with an optional discount code: the discount comes off the items, shipping
 * follows the discounted items, and tax comes last.
 */
export function priceLines(lines, region, code = null) {
  const subtotal = lines.reduce((sum, line) => sum + line.lineCents, 0);
  const discount = discountCents(code, subtotal);
  const items = subtotal - discount;
  const shipping = shippingCents(region, items);
  const tax = taxCents(region, { itemsCents: items, shippingCents: shipping });
  const total = items + shipping + tax;
  const currency = region.currency ?? DEFAULT_CURRENCY;
  return { currency, subtotalCents: subtotal, discountCents: discount, shippingCents: shipping, taxCents: tax, totalCents: total, formatted: formatMoney(total, currency) };
}
