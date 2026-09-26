import { formatPrice } from '@shared/format/price.js';
import { slugify } from '@shared/format/slug.js';

export interface Product {
  sku: string;
  name: string;
  cents: number;
}

/** A product as the storefront shows it: its page, its title and its price. */
export function productCard(product: Product) {
  return { path: `/products/${slugify(product.name)}`, title: product.name, price: formatPrice(product.cents) };
}
