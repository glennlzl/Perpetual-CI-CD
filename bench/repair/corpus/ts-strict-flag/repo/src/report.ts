import type { Stock } from './inventory.js';

/** The SKU with the most units; a tie goes to the SKU listed first. An empty stock has none: null. */
export function topSku(stock: Stock): string | null {
  const entries = Object.entries(stock).sort((a, b) => b[1].quantity - a[1].quantity);
  const first = entries[0];
  return first[0];
}
