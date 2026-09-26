import test from 'node:test';
import assert from 'node:assert/strict';
import { windowAt } from '../src/api/cursor.js';

const posts = Array.from({ length: 25 }, (_, index) => ({ id: index + 1, title: `Post ${index + 1}` }));

test('the first window is at cursor 0', () => {
  const view = windowAt(posts, 0, 10);
  assert.deepEqual(view.items.map(post => post.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(view.next, 1);
});

test('the last window has no next cursor', () => {
  const view = windowAt(posts, 2, 10);
  assert.deepEqual(view.items.map(post => post.id), [21, 22, 23, 24, 25]);
  assert.equal(view.next, null);
});
