import { percentOf } from '../util/round.js';

/** A discount code's reduction of an item total, in cents: its percent, rounded down, once the total reaches its minimum. */
export function discountCents(code, itemsCents) {
  if (!code || itemsCents < (code.minimumCents ?? 0)) return 0;
  return percentOf(itemsCents, code.percent);
}
