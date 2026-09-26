import test from 'node:test';
import assert from 'node:assert/strict';
import { discountPercent, total } from '../../src/invoice.js';

test('holdout: each threshold earns its discount from exactly its minimum', () => {
  assert.deepEqual([0, 4999, 5000, 9999, 10000, 19999, 20000, 50000].map(discountPercent), [0, 0, 5, 5, 10, 10, 15, 15]);
});

test('holdout: totals round down to a whole cent', () => {
  assert.equal(total([{ qty: 1, unitCents: 4999 }]), 4999);
  assert.equal(total([{ qty: 1, unitCents: 5000 }]), 4750);
  assert.equal(total([{ qty: 3, unitCents: 3333 }]), 9499);
  assert.equal(total([{ qty: 1, unitCents: 19999 }]), 17999);
  assert.equal(total([{ qty: 2, unitCents: 10000 }]), 17000);
});
