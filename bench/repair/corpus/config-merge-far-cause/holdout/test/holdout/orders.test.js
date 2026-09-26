import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../src/app.js';

/** An order's totals through the router, after checking that a quote for the same request prices it the same. */
function totals(body, variables = {}) {
  const { handle } = createApp({ env: 'test', variables, now: '2026-03-01T12:00:00.000Z' });
  const quote = handle({ method: 'POST', path: '/quotes', body });
  const order = handle({ method: 'POST', path: '/orders', body });
  assert.equal(quote.status, 200);
  assert.equal(order.status, 201);
  assert.deepEqual(order.body.order.totals, quote.body.quote.totals);
  return order.body.order.totals;
}

test('holdout: US orders pay 8% on their items and none on shipping', () => {
  assert.deepEqual(totals({ region: 'us', lines: [{ sku: 'tee', qty: 1 }, { sku: 'sticker', qty: 3 }] }),
    { currency: 'USD', subtotalCents: 2550, discountCents: 0, shippingCents: 0, taxCents: 204, totalCents: 2754, formatted: 'USD 27.54' });
  assert.deepEqual(totals({ region: 'us', lines: [{ sku: 'tee', qty: 2 }], code: 'SPRING15' }),
    { currency: 'USD', subtotalCents: 3600, discountCents: 540, shippingCents: 0, taxCents: 245, totalCents: 3305, formatted: 'USD 33.05' });
});

test('holdout: EU orders pay 20% on their items and on shipping', () => {
  assert.deepEqual(totals({ region: 'eu', lines: [{ sku: 'cap', qty: 2 }] }),
    { currency: 'EUR', subtotalCents: 2700, discountCents: 0, shippingCents: 900, taxCents: 720, totalCents: 4320, formatted: 'EUR 43.20' });
  assert.deepEqual(totals({ region: 'eu', lines: [{ sku: 'mug', qty: 4 }] }),
    { currency: 'EUR', subtotalCents: 10000, discountCents: 0, shippingCents: 0, taxCents: 2000, totalCents: 12000, formatted: 'EUR 120.00' });
});

test('holdout: Hong Kong orders are tax-free', () => {
  assert.deepEqual(totals({ region: 'hk', lines: [{ sku: 'mug', qty: 1 }, { sku: 'tote', qty: 1 }] }),
    { currency: 'HKD', subtotalCents: 3600, discountCents: 0, shippingCents: 1500, taxCents: 0, totalCents: 5100, formatted: 'HKD 51.00' });
});

test('holdout: an APP_ variable reaches order totals and keeps the rest of the region', () => {
  assert.deepEqual(totals({ region: 'eu', lines: [{ sku: 'cap', qty: 2 }] }, { APP_REGIONS__EU__TAX__RATE: '0.25' }),
    { currency: 'EUR', subtotalCents: 2700, discountCents: 0, shippingCents: 900, taxCents: 900, totalCents: 4500, formatted: 'EUR 45.00' });
});
