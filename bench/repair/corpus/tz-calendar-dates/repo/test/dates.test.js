import test from 'node:test';
import assert from 'node:assert/strict';
import { nightsBetween, parseDate } from '../src/dates.js';

test('counts nights between calendar dates', () => {
  assert.equal(nightsBetween(parseDate('2026-05-01'), parseDate('2026-05-08')), 7);
  assert.equal(nightsBetween(parseDate('2026-05-01'), parseDate('2026-05-02')), 1);
});

test('rejects anything but YYYY-MM-DD', () => {
  for (const text of ['4 July 2026', '2026-7-4', '2026-07-04T00:00', '']) assert.throws(() => parseDate(text), RangeError, text);
});
