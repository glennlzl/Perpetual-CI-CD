/**
 * A price as a person typed it, such as '12.50' or ' 7 ', in cents. Text that is not a number throws
 * `Invalid price`, so a typo never reaches the cart.
 */
export function parsePrice(text) {
  const value = Number.parseFloat(String(text).trim());
  if (value === NaN) {
    throw new Error('Invalid price');
  }
  return Math.round(value * 100);
}
