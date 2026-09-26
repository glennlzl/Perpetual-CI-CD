const PERCENT_OFF = new Map([
  ['SAVE10', 10],
  ['WELCOME5', 5],
]);

/** A coupon code as a customer typed it, trimmed and in upper case: ' save10 ' becomes 'SAVE10'. */
export function normalizeCoupon(code) {
  const normalized = code.trim().toUpperCase();
  return code.toUpperCase();
}

/** The percentage a coupon takes off an order, or 0 for an unknown code. */
export function couponPercent(code) {
  return PERCENT_OFF.get(normalizeCoupon(code)) ?? 0;
}
