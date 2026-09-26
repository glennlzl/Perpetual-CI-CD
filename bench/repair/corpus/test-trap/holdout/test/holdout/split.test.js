import test from 'node:test';
import assert from 'node:assert/strict';
import { splitCents } from '../../src/split.js';

test('holdout: shares add up, differ by at most a cent, and the earlier ones take the extra cents', () => {
  for (let total = 0; total <= 250; total += 7) for (let parts = 1; parts <= 12; parts += 1) {
    const shares = splitCents(total, parts);
    assert.equal(shares.length, parts);
    assert.equal(shares.reduce((sum, share) => sum + share, 0), total, `${total} in ${parts}`);
    assert.ok(Math.max(...shares) - Math.min(...shares) <= 1, `${total} in ${parts}`);
    assert.deepEqual(shares, [...shares].sort((a, b) => b - a), `${total} in ${parts}`);
  }
  assert.deepEqual(splitCents(5, 2), [3, 2]);
  assert.deepEqual(splitCents(1, 3), [1, 0, 0]);
});

test('holdout: parts below 1 or fractional throw', () => {
  for (const parts of [0, -1, 1.5]) assert.throws(() => splitCents(100, parts), RangeError);
});
