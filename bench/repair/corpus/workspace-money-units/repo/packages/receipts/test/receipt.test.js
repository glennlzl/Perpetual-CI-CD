import test from 'node:test';
import assert from 'node:assert/strict';
import { receipt } from '../src/receipt.js';

test('a receipt starts with its number', () => {
  assert.equal(receipt({ number: 'R-1001', currency: 'USD', lines: [] }).split('\n')[0], 'Receipt R-1001');
});
