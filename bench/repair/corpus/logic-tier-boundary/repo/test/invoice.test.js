import test from 'node:test';
import assert from 'node:assert/strict';
import { subtotal, total } from '../src/invoice.js';

test('a subtotal adds every line', () => {
  assert.equal(subtotal([{ qty: 2, unitCents: 1250 }, { qty: 1, unitCents: 499 }]), 2999);
});

test('an order of exactly $100.00 earns the 10% discount', () => {
  assert.equal(total([{ qty: 4, unitCents: 2500 }]), 9000);
});

test('a small order pays full price', () => {
  assert.equal(total([{ qty: 1, unitCents: 1999 }]), 1999);
});
