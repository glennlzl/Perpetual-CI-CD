/** Ids for new records, numbered from 1 per prefix: ord_0001, ord_0002, … Each call starts its own numbering. */
export function createIds() {
  const counts = new Map();
  return prefix => {
    const count = (counts.get(prefix) ?? 0) + 1;
    counts.set(prefix, count);
    return `${prefix}_${String(count).padStart(4, '0')}`;
  };
}
