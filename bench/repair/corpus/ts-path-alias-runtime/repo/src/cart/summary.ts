import { formatPrice } from '../utils/price.js';
import type { Product } from '../catalog/product.js';

export interface CartLine {
  product: Product;
  quantity: number;
}

/** The cart's item count and total price, such as '3 items, $52.97'. */
export function cartSummary(lines: readonly CartLine[]): string {
  const count = lines.reduce((sum, line) => sum + line.quantity, 0);
  const cents = lines.reduce((sum, line) => sum + line.product.cents * line.quantity, 0);
  return `${count} ${count === 1 ? 'item' : 'items'}, ${formatPrice(cents)}`;
}
