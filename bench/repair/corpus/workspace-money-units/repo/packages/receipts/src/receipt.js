import { format } from '@acme/money';

/**
 * The receipt text of an order { number, currency, lines }, each line { sku, price, qty } with its unit price as a
 * decimal string: a header, one row per line with its unit price and amount, and the total.
 */
export function receipt({ number, currency, lines }) {
  const rows = lines.map(({ sku, price, qty }) => `${qty} × ${sku} @ ${format(Number(price), currency)}  ${format(Number(price) * qty, currency)}`);
  const total = lines.reduce((sum, { price, qty }) => sum + Number(price) * qty, 0);
  return [`Receipt ${number}`, ...rows, `Total  ${format(total, currency)}`].join('\n');
}
