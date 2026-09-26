import test from 'node:test';
import assert from 'node:assert/strict';
import { Cart } from '../../src/cart.js';

test('holdout: totals use each currency\'s decimals', () => {
  assert.equal(new Cart('USD').add('MUG', '8.25', 3).add('TEE', '15.99').summary(), 'Total: $40.74');
  assert.equal(new Cart('EUR').add('DESK', '617.25', 2).summary(), 'Total: €1,234.50');
  assert.equal(new Cart('JPY').add('SOAP', '1250', 3).summary(), 'Total: ¥3,750');
  assert.equal(new Cart('KWD').add('TEA', '0.625', 2).summary(), 'Total: KD 1.250');
});

test('holdout: a whole-unit price is whole units', () => {
  assert.equal(new Cart('USD').add('CAP', '12').summary(), 'Total: $12.00');
  assert.equal(new Cart('EUR').add('LAMP', '40', 2).summary(), 'Total: €80.00');
});

test('holdout: cent prices add up exactly', () => {
  assert.equal(new Cart('USD').add('PIN', '0.10').add('CLIP', '0.20').summary(), 'Total: $0.30');
  assert.equal(new Cart('USD').add('GUM', '0.57', 3).summary(), 'Total: $1.71');
});
