import test from 'node:test';
import assert from 'node:assert/strict';
import { cartSummary, formatPrice, listing, productCard, slugify } from '../dist/index.js';

const kettle = { sku: 'k1', name: 'Steel Kettle', cents: 3499 };
const mug = { sku: 'm1', name: 'Blue Mug', cents: 899 };

test('a product card links to its slug and shows its price', () => {
  assert.deepEqual(productCard(kettle), { path: '/products/steel-kettle', title: 'Steel Kettle', price: '$34.99' });
});

test('a category listing is cheapest first', () => {
  assert.deepEqual(listing('Kitchen & Dining', [kettle, mug]), { path: '/c/kitchen-dining', lines: ['Blue Mug $8.99', 'Steel Kettle $34.99'] });
});

test('the cart summary counts items and adds their prices', () => {
  assert.equal(cartSummary([{ product: kettle, quantity: 1 }, { product: mug, quantity: 2 }]), '3 items, $52.97');
});

test('the helpers are exported', () => {
  assert.equal(formatPrice(5), '$0.05');
  assert.equal(slugify('  Hello, World  '), 'hello-world');
});
