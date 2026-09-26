import test from 'node:test';
import assert from 'node:assert/strict';
import { format, toMinor } from '../../src/index.js';

test('holdout: format reads every number as minor units', () => {
  assert.equal(format(12, 'USD'), '$0.12');
  assert.equal(format(1250, 'KWD'), 'KD 1.250');
  assert.equal(format(123450, 'EUR'), '€1,234.50');
  assert.throws(() => format(12.5, 'USD'), TypeError);
});

test('holdout: toMinor parses with the currency\'s decimals', () => {
  assert.equal(toMinor('12.5', 'USD'), 1250);
  assert.equal(toMinor('0.625', 'KWD'), 625);
  assert.equal(toMinor('3750', 'JPY'), 3750);
});
