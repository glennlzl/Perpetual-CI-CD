import test from 'node:test';
import assert from 'node:assert/strict';
import { notice } from '../../src/messages.js';

test('holdout: optional fields may be left out', () => {
  assert.equal(notice('renewal', { name: 'Ada', plan: 'Pro', date: '2026-02-01' }), 'Hi Ada, your Pro plan renews on 2026-02-01.');
  assert.equal(notice('receipt', { number: 7, amount: '$12.00', name: 'Ada' }), 'Receipt 7: $12.00 paid by Ada.');
});

test('holdout: every template renders its fields', () => {
  assert.equal(notice('receipt', { number: 8, amount: '$3.50', name: 'Grace', footer: ' See you soon.' }), 'Receipt 8: $3.50 paid by Grace. See you soon.');
  assert.throws(() => notice('refund', {}), /Unknown notice refund/);
});
