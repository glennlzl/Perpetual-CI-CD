import type { Row } from './csv.js';

export type Stock = Record<string, { quantity: number }>;

/** Stock by SKU; the quantities of a repeated SKU add up. */
export function toStock(rows: readonly Row[]): Stock {
  const stock: Stock = {};
  for (const row of rows) {
    const entry = stock[row.sku];
    if (entry) entry.quantity += row.quantity;
    else stock[row.sku] = { quantity: row.quantity };
  }
  return stock;
}

/** Units in stock for a SKU; an unknown SKU has 0. */
export function quantityOf(stock: Stock, sku: string): number {
  return stock[sku].quantity;
}
