import test from 'node:test';
import assert from 'node:assert/strict';
import { listPosts } from '../src/api/posts.js';

const posts = Array.from({ length: 25 }, (_, index) => ({ id: index + 1, title: `Post ${index + 1}` }));
const ids = page => page.items.map(post => post.id);

test('page 1 is the first page', () => {
  const page = listPosts(posts, { page: 1, perPage: 10 });
  assert.deepEqual(ids(page), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(page.hasNext, true);
});

test('page 3 is the last page', () => {
  const page = listPosts(posts, { page: 3, perPage: 10 });
  assert.deepEqual(ids(page), [21, 22, 23, 24, 25]);
  assert.equal(page.hasNext, false);
});

test('page 0 is refused', () => {
  assert.throws(() => listPosts(posts, { page: 0, perPage: 10 }), { name: 'RangeError', message: 'page must be a whole number from 1' });
});
