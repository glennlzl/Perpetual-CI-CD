import { pageSlice } from '../lib/paging.js';

/**
 * Posts whose title contains the query, ignoring case, a page of results at a time. resultPage counts from 0, as the
 * search box's "more results" button asks for them.
 */
export function searchPosts(posts, query, { resultPage = 0, perPage = 5 } = {}) {
  const needle = String(query ?? '').trim().toLowerCase();
  const matches = needle ? posts.filter(post => post.title.toLowerCase().includes(needle)) : [];
  const { items, hasNext } = pageSlice(matches, resultPage, perPage);
  return { query: needle, resultPage, total: matches.length, items, hasNext };
}
