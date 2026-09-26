import { roundCents } from '../util/round.js';

/**
 * The tax in cents on items and shipping in a region: its tax rate of the items, and of shipping too where the region
 * taxes shipping. A region without a tax section is tax-free.
 */
export function taxCents(region, { itemsCents, shippingCents }) {
  const rate = region.tax?.rate ?? 0;
  return roundCents((itemsCents + (region.tax?.shipping ? shippingCents : 0)) * rate);
}
