import test from 'node:test';
import assert from 'node:assert/strict';
import { windowAt } from '../../src/api/cursor.js';
import { exportBatches } from '../../src/api/export.js';
import { listPosts } from '../../src/api/posts.js';
import { searchPosts } from '../../src/api/search.js';

// 17 posts, ids 100 to 116; every third title (ids 100, 103, … 115) is release notes, the rest weekly digests.
const posts = Array.from({ length: 17 }, (_, index) => ({ id: 100 + index, title: index % 3 === 0 ? `Release notes ${index}` : `Weekly digest ${index}` }));
const ids = result => result.items.map(post => post.id);

test('holdout: public pages count from 1 to the last page, and a page past it is empty', () => {
  assert.deepEqual(ids(listPosts(posts, { page: 1, perPage: 4 })), [100, 101, 102, 103]);
  assert.deepEqual(ids(listPosts(posts, { page: 2, perPage: 4 })), [104, 105, 106, 107]);
  assert.equal(listPosts(posts, { page: 4, perPage: 4 }).hasNext, true);
  assert.deepEqual(listPosts(posts, { page: 5, perPage: 4 }), { page: 5, perPage: 4, items: [posts[16]], hasNext: false });
  assert.deepEqual(listPosts(posts, { page: 6, perPage: 4 }), { page: 6, perPage: 4, items: [], hasNext: false });
});

test('holdout: perPage runs from 1 to 100, and the defaults are page 1 of 10', () => {
  assert.deepEqual(ids(listPosts(posts, { page: 1, perPage: 1 })), [100]);
  assert.deepEqual(listPosts(posts, { page: 17, perPage: 1 }), { page: 17, perPage: 1, items: [posts[16]], hasNext: false });
  const all = listPosts(posts, { page: 1, perPage: 100 });
  assert.equal(all.items.length, 17);
  assert.equal(all.hasNext, false);
  assert.deepEqual(ids(listPosts(posts)), [100, 101, 102, 103, 104, 105, 106, 107, 108, 109]);
});

test('holdout: a page or perPage out of range throws', () => {
  for (const page of [0, -1, 1.5]) assert.throws(() => listPosts(posts, { page, perPage: 4 }), RangeError);
  for (const perPage of [0, 101, 2.5]) assert.throws(() => listPosts(posts, { page: 1, perPage }), RangeError);
});

test('holdout: search result pages count from 0', () => {
  const first = searchPosts(posts, 'release', { resultPage: 0, perPage: 4 });
  assert.deepEqual(ids(first), [100, 103, 106, 109]);
  assert.equal(first.total, 6);
  assert.equal(first.hasNext, true);
  const second = searchPosts(posts, 'RELEASE', { resultPage: 1, perPage: 4 });
  assert.deepEqual(ids(second), [112, 115]);
  assert.equal(second.hasNext, false);
  assert.deepEqual(ids(searchPosts(posts, 'digest')), [101, 102, 104, 105, 107]);
});

test('holdout: export batches and cursor windows count from 0', () => {
  const batches = exportBatches(posts, 6);
  assert.deepEqual(batches.map(batch => [batch.batch, batch.file, batch.ids.length]), [[0, 'posts-0.json', 6], [1, 'posts-1.json', 6], [2, 'posts-2.json', 5]]);
  assert.deepEqual(batches[2].ids, [112, 113, 114, 115, 116]);
  const start = windowAt(posts, 0, 7);
  assert.deepEqual(ids(start), [100, 101, 102, 103, 104, 105, 106]);
  assert.equal(start.next, 1);
  const end = windowAt(posts, 2, 7);
  assert.deepEqual(ids(end), [114, 115, 116]);
  assert.equal(end.next, null);
});
