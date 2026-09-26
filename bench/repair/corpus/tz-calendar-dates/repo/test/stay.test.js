import test from 'node:test';
import assert from 'node:assert/strict';
import { formatStay, quoteStay } from '../src/stay.js';

const rates = { weekday: 12000, weekend: 15000 };

test('labels a stay with weekday names', () => {
  assert.equal(formatStay({ checkIn: '2026-03-06', checkOut: '2026-03-09' }), 'Fri 6 Mar – Mon 9 Mar (3 nights)');
});

test('a one-night stay reads 1 night', () => {
  assert.equal(formatStay({ checkIn: '2026-01-15', checkOut: '2026-01-16' }), 'Thu 15 Jan – Fri 16 Jan (1 night)');
});

test('Friday and Saturday nights take the weekend rate', () => {
  assert.deepEqual(quoteStay({ checkIn: '2026-03-06', checkOut: '2026-03-09', rates }), {
    nights: 3,
    lines: [
      { night: '2026-03-06', weekend: true, cents: 15000 },
      { night: '2026-03-07', weekend: true, cents: 15000 },
      { night: '2026-03-08', weekend: false, cents: 12000 },
    ],
    total: 42000,
  });
});

test('a stay is at least one night', () => {
  assert.throws(() => quoteStay({ checkIn: '2026-03-06', checkOut: '2026-03-06', rates }), RangeError);
});
