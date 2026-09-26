import test from 'node:test';
import assert from 'node:assert/strict';
import { discountCents } from '../../src/pricing/discounts.js';

test('a code takes its percent off, rounded down', () => {
  assert.equal(discountCents({ percent: 15 }, 2999), 449);
});

test('a code with a minimum applies from that total', () => {
  const code = { percent: 10, minimumCents: 3000 };
  assert.equal(discountCents(code, 2999), 0);
  assert.equal(discountCents(code, 3000), 300);
});

test('without a code there is no discount', () => {
  assert.equal(discountCents(null, 5000), 0);
});
