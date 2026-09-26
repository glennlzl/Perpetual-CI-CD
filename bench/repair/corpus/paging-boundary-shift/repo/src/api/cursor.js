import { pageSlice } from '../lib/paging.js';

/** The cursor feed: the window of posts at a cursor counted from 0, and the next window's cursor, or null after the last. */
export function windowAt(posts, cursor = 0, size = 20) {
  if (!Number.isInteger(cursor) || cursor < 0) throw new RangeError('cursor must be a whole number from 0');
  const { items, hasNext } = pageSlice(posts, cursor, size);
  return { cursor, items, next: hasNext ? cursor + 1 : null };
}
