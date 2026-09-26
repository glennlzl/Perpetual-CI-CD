// Amounts of money as integer minor units: cents for USD and EUR, yen for JPY, fils for KWD.
import { CURRENCIES } from './currencies.js';

/** A currency's symbol and exponent (its number of decimals). A currency this package does not know throws a RangeError. */
export function currency(code) {
  if (!Object.hasOwn(CURRENCIES, code)) throw new RangeError(`Unknown currency ${code}`);
  return CURRENCIES[code];
}

/**
 * An integer number of minor units, formatted in its currency: format(123450, 'EUR') is '€1,234.50' and
 * format(3750, 'JPY') is '¥3,750'. Anything but a safe integer throws a TypeError.
 */
export function format(minor, code) {
  const { symbol, exponent } = currency(code);
  if (!Number.isSafeInteger(minor)) throw new TypeError(`format() takes an integer number of minor units, got ${minor}`);
  const digits = String(Math.abs(minor)).padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent).replace(/\B(?=(\d{3})+$)/g, ',');
  return `${minor < 0 ? '-' : ''}${symbol}${whole}${exponent ? `.${digits.slice(-exponent)}` : ''}`;
}

/**
 * A decimal amount, such as a catalog price, in integer minor units: toMinor('19.99', 'USD') is 1999 and
 * toMinor('1250', 'JPY') is 1250. Text that is not a decimal amount, or has more decimals than the currency, throws a
 * RangeError.
 */
export function toMinor(amount, code) {
  const { exponent } = currency(code);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(amount).trim());
  if (!match || (match[3] ?? '').length > exponent) throw new RangeError(`${amount} is not an amount in ${code}`);
  const minor = Number(match[2] + (match[3] ?? '').padEnd(exponent, '0'));
  return match[1] && minor ? -minor : minor;
}
