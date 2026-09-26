import test from 'node:test';
import assert from 'node:assert/strict';
import { receipt } from '../../src/receipt.js';

test('holdout: a receipt shows each line\'s unit price and amount, and the total', () => {
  const text = receipt({ number: 'R-2001', currency: 'USD', lines: [{ sku: 'MUG', price: '8.25', qty: 3 }, { sku: 'CAP', price: '12', qty: 1 }] });
  assert.equal(text, ['Receipt R-2001', '3 × MUG @ $8.25  $24.75', '1 × CAP @ $12.00  $12.00', 'Total  $36.75'].join('\n'));
});

test('holdout: a receipt in yen has no decimals', () => {
  const text = receipt({ number: 'R-2002', currency: 'JPY', lines: [{ sku: 'SOAP', price: '480', qty: 2 }, { sku: 'TOWEL', price: '1200', qty: 1 }] });
  assert.equal(text, ['Receipt R-2002', '2 × SOAP @ ¥480  ¥960', '1 × TOWEL @ ¥1,200  ¥1,200', 'Total  ¥2,160'].join('\n'));
});
