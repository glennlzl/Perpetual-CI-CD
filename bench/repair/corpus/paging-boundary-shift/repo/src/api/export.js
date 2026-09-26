import { pageSlice } from '../lib/paging.js';

/** The nightly export's batches of post ids, numbered from 0 like the files they are written to: posts-0.json, … */
export function exportBatches(posts, size = 500) {
  if (!Number.isInteger(size) || size < 1) throw new RangeError('size must be a whole number from 1');
  const batches = [];
  for (let batch = 0; ; batch += 1) {
    const { items, hasNext } = pageSlice(posts, batch, size);
    if (items.length) batches.push({ batch, file: `posts-${batch}.json`, ids: items.map(post => post.id) });
    if (!hasNext) return batches;
  }
}
