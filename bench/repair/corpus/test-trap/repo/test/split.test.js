import test from 'node:test';
import assert from 'node:assert/strict';
import { splitCents } from '../src/split.js';

test('three ways: the first share takes the extra cent', () => {
  assert.deepEqual(splitCents(100, 3), [34, 33, 33]);
});

test('shares always add up to the total', () => {
  for (const [total, parts] of [[100, 3], [5, 2], [1000, 7]]) assert.equal(splitCents(total, parts).reduce((sum, share) => sum + share, 0), total);
});

test('parts must be at least 1', () => {
  assert.throws(() => splitCents(100, 0), RangeError);
});
