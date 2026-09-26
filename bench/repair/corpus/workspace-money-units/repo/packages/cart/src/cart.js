import { format } from '@acme/money';

/** A shopping cart in one currency. */
export class Cart {
  constructor(currency) {
    this.currency = currency;
    this.lines = [];
  }

  /**
   * Adds qty units of sku at a unit price, a decimal string as the catalog lists it: '12.50' in USD, '1250' in JPY.
   * Returns the cart. A quantity that is not a whole number of at least 1 throws a RangeError.
   */
  add(sku, price, qty = 1) {
    if (!Number.isInteger(qty) || qty < 1) throw new RangeError(`Quantity must be a whole number of at least 1, got ${qty}`);
    this.lines.push({ sku, price, qty });
    return this;
  }

  /** The line checkout shows, such as 'Total: $25.00'. */
  summary() {
    const total = this.lines.reduce((sum, line) => sum + Number(line.price) * line.qty, 0);
    return `Total: ${format(total, this.currency)}`;
  }
}
