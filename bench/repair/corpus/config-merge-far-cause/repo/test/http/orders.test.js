import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from '../helpers/app.js';

test('a US order pays sales tax on its items', () => {
  const { request } = testApp();
  const response = request('POST', '/orders', { region: 'us', lines: [{ sku: 'mug', qty: 2 }] });
  assert.equal(response.status, 201);
  assert.equal(response.body.order.totals.totalCents, 5400);
  assert.equal(response.body.order.totals.currency, 'USD');
});

test('a placed order reads back unchanged', () => {
  const { request } = testApp();
  const placed = request('POST', '/orders', { region: 'eu', lines: [{ sku: 'tee', qty: 1 }] }).body.order;
  const response = request('GET', `/orders/${placed.id}`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.order, placed);
  assert.equal(placed.id, 'ord_0001');
});

test('an order for an unknown product is refused', () => {
  const { request } = testApp();
  const response = request('POST', '/orders', { region: 'us', lines: [{ sku: 'kettle', qty: 1 }] });
  assert.equal(response.status, 400);
  assert.match(response.body.error, /kettle/);
});
