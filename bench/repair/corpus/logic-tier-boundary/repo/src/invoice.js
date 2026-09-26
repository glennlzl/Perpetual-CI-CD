// Volume discounts by order subtotal, in cents: [minimum subtotal, percent off], highest tier first.
export const TIERS = [[20000, 15], [10000, 10], [5000, 5]];

/** The percent off for a subtotal in cents: the first tier whose minimum the subtotal reaches. */
export function discountPercent(subtotal) {
  for (const [min, percent] of TIERS) if (subtotal > min) return percent;
  return 0;
}

/** The subtotal in cents of invoice lines, each { qty, unitCents }. */
export const subtotal = lines => lines.reduce((sum, line) => sum + line.qty * line.unitCents, 0);

/** The total in cents after the volume discount, rounded down to a whole cent. */
export function total(lines) {
  const amount = subtotal(lines);
  return Math.floor(amount * (100 - discountPercent(amount)) / 100);
}
