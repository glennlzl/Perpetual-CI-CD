import test from 'node:test';
import assert from 'node:assert/strict';
import { shippingCents } from '../../src/pricing/shipping.js';

const region = { shipping: { flat: 599, freeFrom: 5000 } };

test('items below the threshold pay the flat charge', () => {
  assert.equal(shippingCents(region, 4999), 599);
});

test('items from the threshold ship free', () => {
  assert.equal(shippingCents(region, 5000), 0);
  assert.equal(shippingCents(region, 12000), 0);
});

test('a region without a threshold always charges its flat rate', () => {
  assert.equal(shippingCents({ shipping: { flat: 350 } }, 90000), 350);
});
