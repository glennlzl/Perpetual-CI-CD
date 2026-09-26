import test from 'node:test';
import assert from 'node:assert/strict';
import { orderTotal } from '../src/checkout.js';
import { couponPercent } from '../src/coupon.js';
import { parsePrice } from '../src/price.js';
import { shippingFor } from '../src/shipping.js';

test('prices are parsed to cents', () => {
  assert.equal(parsePrice('12.50'), 1250);
  assert.equal(parsePrice('7'), 700);
});

test('domestic and international shipping', () => {
  assert.equal(shippingFor('domestic'), 499);
  assert.equal(shippingFor('intl'), 1999);
});

test('coupons take their percentage off', () => {
  assert.equal(couponPercent('SAVE10'), 10);
  assert.equal(couponPercent('welcome5'), 5);
  assert.equal(couponPercent('NOPE'), 0);
});

test('an order total', () => {
  assert.equal(orderTotal({ prices: ['20.00', '5.50'], coupon: 'SAVE10', region: 'domestic' }), 2794);
});
