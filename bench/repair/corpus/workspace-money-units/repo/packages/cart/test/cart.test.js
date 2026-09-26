import test from 'node:test';
import assert from 'node:assert/strict';
import { Cart } from '../src/cart.js';

test('an empty cart totals zero', () => {
  assert.equal(new Cart('USD').summary(), 'Total: $0.00');
});

test('a cart totals its lines', () => {
  assert.equal(new Cart('USD').add('BOOK', '12.50', 2).summary(), 'Total: $25.00');
});

test('a price in cents totals exactly', () => {
  assert.equal(new Cart('USD').add('PEN', '19.99').summary(), 'Total: $19.99');
});

test('a quantity is a whole number of at least 1', () => {
  assert.throws(() => new Cart('USD').add('PEN', '19.99', 0), RangeError);
  assert.throws(() => new Cart('USD').add('PEN', '19.99', 1.5), RangeError);
});
