import test from 'node:test';
import assert from 'node:assert/strict';
import { taxCents } from '../../src/pricing/tax.js';

test('tax is the region rate of the items', () => {
  assert.equal(taxCents({ tax: { rate: 0.1, shipping: false } }, { itemsCents: 1250, shippingCents: 500 }), 125);
});

test('a region that taxes shipping taxes it as well', () => {
  assert.equal(taxCents({ tax: { rate: 0.1, shipping: true } }, { itemsCents: 1250, shippingCents: 500 }), 175);
});

test('tax rounds to the nearest cent', () => {
  assert.equal(taxCents({ tax: { rate: 0.075 } }, { itemsCents: 1999, shippingCents: 0 }), 150);
});
