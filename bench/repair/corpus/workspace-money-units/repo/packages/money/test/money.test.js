import test from 'node:test';
import assert from 'node:assert/strict';
import { format, toMinor } from '../src/index.js';

test('format prints minor units with the currency\'s decimals', () => {
  assert.equal(format(1999, 'USD'), '$19.99');
  assert.equal(format(5, 'EUR'), '€0.05');
  assert.equal(format(123456789, 'USD'), '$1,234,567.89');
  assert.equal(format(500, 'JPY'), '¥500');
  assert.equal(format(12345, 'KWD'), 'KD 12.345');
});

test('format takes nothing but an integer number of minor units', () => {
  assert.throws(() => format(19.99, 'USD'), TypeError);
  assert.throws(() => format('1999', 'USD'), TypeError);
});

test('toMinor reads a decimal amount with the currency\'s decimals', () => {
  assert.equal(toMinor('19.99', 'USD'), 1999);
  assert.equal(toMinor('7', 'EUR'), 700);
  assert.equal(toMinor('500', 'JPY'), 500);
  assert.throws(() => toMinor('1.999', 'USD'), RangeError);
  assert.throws(() => toMinor('12,50', 'EUR'), RangeError);
});
