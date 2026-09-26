import test from 'node:test';
import assert from 'node:assert/strict';
import { exportBatches } from '../src/api/export.js';

const posts = Array.from({ length: 25 }, (_, index) => ({ id: index + 1, title: `Post ${index + 1}` }));

test('the export writes batches numbered from 0', () => {
  const batches = exportBatches(posts, 10);
  assert.deepEqual(batches.map(batch => batch.file), ['posts-0.json', 'posts-1.json', 'posts-2.json']);
  assert.deepEqual(batches[0].ids, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(batches[2].ids, [21, 22, 23, 24, 25]);
});

test('an empty feed exports nothing', () => {
  assert.deepEqual(exportBatches([], 10), []);
});
