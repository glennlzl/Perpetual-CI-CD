import { pageSlice } from '../lib/paging.js';

/** The most posts a public page shows. */
export const MAX_PER_PAGE = 100;

/** A page of the public post list. Pages are numbered from 1, as the site's page links show them. */
export function listPosts(posts, { page = 1, perPage = 10 } = {}) {
  if (!Number.isInteger(page) || page < 1) throw new RangeError('page must be a whole number from 1');
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > MAX_PER_PAGE) throw new RangeError(`perPage must be a whole number from 1 to ${MAX_PER_PAGE}`);
  const { items, hasNext } = pageSlice(posts, page, perPage);
  return { page, perPage, items, hasNext };
}
