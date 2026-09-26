/** A placed order: its lines and totals as priced when it was placed. A placed order never changes. */
export function createOrder({ id, placedAt, region, code, lines, totals }) {
  return Object.freeze({ id, status: 'placed', placedAt, region, code, lines: Object.freeze([...lines]), totals: Object.freeze({ ...totals }) });
}
