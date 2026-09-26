import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from '../helpers/app.js';

test('a US quote adds sales tax', () => {
  const { request } = testApp();
  const response = request('POST', '/quotes', { region: 'us', lines: [{ sku: 'mug', qty: 2 }] });
  assert.equal(response.status, 200);
  assert.equal(response.body.quote.totals.totalCents, 5400);
  assert.equal(response.body.quote.totals.taxCents, 400);
});

test('a discount comes off the items before shipping and tax', () => {
  const { request } = testApp();
  const { totals } = request('POST', '/quotes', { region: 'eu', lines: [{ sku: 'tee', qty: 2 }], code: 'SPRING15' }).body.quote;
  assert.deepEqual(totals, { currency: 'EUR', subtotalCents: 3600, discountCents: 540, shippingCents: 900, taxCents: 792, totalCents: 4752, formatted: 'EUR 47.52' });
});

test('a quote for an unknown region is not found', () => {
  const { request } = testApp();
  assert.equal(request('POST', '/quotes', { region: 'mars', lines: [{ sku: 'mug', qty: 1 }] }).status, 404);
});
