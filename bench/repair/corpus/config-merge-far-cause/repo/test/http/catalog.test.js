import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from '../helpers/app.js';

test('the catalog lists every product', () => {
  const { request } = testApp();
  const response = request('GET', '/products');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.products.map(product => product.sku), ['mug', 'tee', 'cap', 'tote', 'sticker']);
});

test('a product reads by its sku', () => {
  const { request } = testApp();
  assert.deepEqual(request('GET', '/products/cap').body.product, { sku: 'cap', name: 'Cap', unitCents: 1350 });
});

test('an unknown product is not found', () => {
  const { request } = testApp();
  assert.equal(request('GET', '/products/kettle').status, 404);
});
