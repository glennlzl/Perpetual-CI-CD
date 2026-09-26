export type Currency = 'USD' | 'EUR';

const SYMBOLS: Record<Currency, string> = { USD: '$', EUR: '€' };

/** Cents as a price with its currency's symbol: 1999 is '$19.99', and -250 in EUR is '-€2.50'. */
export function formatPrice(cents: number, currency: Currency = 'USD'): string {
  const whole = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}${SYMBOLS[currency]}${Math.floor(whole / 100)}.${String(whole % 100).padStart(2, '0')}`;
}
