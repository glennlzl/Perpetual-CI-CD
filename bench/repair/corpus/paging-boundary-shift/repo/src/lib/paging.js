/**
 * One page of items by its 0-based index: the items from index * size up to (index + 1) * size, and whether any come
 * after them. Index and size are trusted; callers check what they take from outside.
 */
export function pageSlice(items, index, size) {
  const start = index * size;
  return { items: items.slice(start, start + size), hasNext: start + size < items.length };
}
