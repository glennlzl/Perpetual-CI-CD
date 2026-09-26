/** The currency of a region that names none. */
export const DEFAULT_CURRENCY = 'USD';

/** Whether a value is whole, non-negative cents. */
export const isCents = value => Number.isInteger(value) && value >= 0;

/** Cents as text with their currency: formatMoney(5400, 'USD') is 'USD 54.00'. */
export function formatMoney(cents, currency = DEFAULT_CURRENCY) {
  return `${currency} ${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}
