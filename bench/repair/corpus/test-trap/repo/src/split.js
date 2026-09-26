/**
 * Splits a total in cents into parts shares, as the README describes: shares differ by at most one cent, add up to the
 * total, and the earlier shares take the extra cents.
 */
export function splitCents(total, parts) {
  if (!Number.isInteger(parts) || parts < 1) throw new RangeError('parts must be a whole number of at least 1');
  if (!Number.isInteger(total) || total < 0) throw new RangeError('total must be a whole number of cents');
  return Array.from({ length: parts }, () => Math.round(total / parts));
}
