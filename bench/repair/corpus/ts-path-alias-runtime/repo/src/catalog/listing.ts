import { formatPrice } from '@shared/format/price.js';
import { slugify } from '@shared/format/slug.js';
import type { Product } from './product.js';

/** A category page: its path and one line per product, cheapest first. */
export function listing(category: string, products: readonly Product[]) {
  const lines = [...products].sort((a, b) => a.cents - b.cents).map(product => `${product.name} ${formatPrice(product.cents)}`);
  return { path: `/c/${slugify(category)}`, lines };
}
