import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, formatDate, nightsBetween, parseDate } from '../../src/dates.js';
import { formatStay, quoteStay } from '../../src/stay.js';

// Zones a server may run in: UTC, west and east of it, half-hour offsets, and both hemispheres' daylight saving.
const ZONES = ['UTC', 'America/New_York', 'America/Los_Angeles', 'America/St_Johns', 'Asia/Kolkata', 'Asia/Tokyo', 'Pacific/Auckland'];
const rates = { weekday: 9900, weekend: 12900 };
const night = (date, weekend) => ({ night: date, weekend, cents: weekend ? rates.weekend : rates.weekday });

// Runs check with the process in each zone, set after the modules loaded, as a server's zone may be.
function eachZone(check) {
  for (const zone of ZONES) {
    process.env.TZ = zone;
    check(zone);
    assert.equal(process.env.TZ, zone, `${zone}: the code changed the process's time zone`);
  }
}

test('holdout: stay labels are the same in every zone, across daylight saving changes, leap days and year ends', () => {
  eachZone(zone => {
    assert.equal(formatStay({ checkIn: '2026-03-07', checkOut: '2026-03-10' }), 'Sat 7 Mar – Tue 10 Mar (3 nights)', zone);
    assert.equal(formatStay({ checkIn: '2026-10-31', checkOut: '2026-11-02' }), 'Sat 31 Oct – Mon 2 Nov (2 nights)', zone);
    assert.equal(formatStay({ checkIn: '2026-04-04', checkOut: '2026-04-06' }), 'Sat 4 Apr – Mon 6 Apr (2 nights)', zone);
    assert.equal(formatStay({ checkIn: '2026-09-26', checkOut: '2026-09-28' }), 'Sat 26 Sep – Mon 28 Sep (2 nights)', zone);
    assert.equal(formatStay({ checkIn: '2028-02-28', checkOut: '2028-03-01' }), 'Mon 28 Feb – Wed 1 Mar (2 nights)', zone);
    assert.equal(formatStay({ checkIn: '2026-12-31', checkOut: '2027-01-01' }), 'Thu 31 Dec – Fri 1 Jan (1 night)', zone);
  });
});

test('holdout: quotes are the same in every zone, across daylight saving changes, leap days and year ends', () => {
  eachZone(zone => {
    assert.deepEqual(quoteStay({ checkIn: '2026-03-07', checkOut: '2026-03-10', rates }), {
      nights: 3, lines: [night('2026-03-07', true), night('2026-03-08', false), night('2026-03-09', false)], total: 32700,
    }, zone);
    assert.deepEqual(quoteStay({ checkIn: '2026-10-30', checkOut: '2026-11-02', rates }), {
      nights: 3, lines: [night('2026-10-30', true), night('2026-10-31', true), night('2026-11-01', false)], total: 35700,
    }, zone);
    assert.deepEqual(quoteStay({ checkIn: '2026-04-03', checkOut: '2026-04-06', rates }), {
      nights: 3, lines: [night('2026-04-03', true), night('2026-04-04', true), night('2026-04-05', false)], total: 35700,
    }, zone);
    assert.deepEqual(quoteStay({ checkIn: '2026-09-25', checkOut: '2026-09-28', rates }), {
      nights: 3, lines: [night('2026-09-25', true), night('2026-09-26', true), night('2026-09-27', false)], total: 35700,
    }, zone);
    assert.deepEqual(quoteStay({ checkIn: '2028-02-27', checkOut: '2028-03-02', rates }), {
      nights: 4, lines: [night('2028-02-27', false), night('2028-02-28', false), night('2028-02-29', false), night('2028-03-01', false)], total: 39600,
    }, zone);
    assert.deepEqual(quoteStay({ checkIn: '2026-12-30', checkOut: '2027-01-03', rates }), {
      nights: 4, lines: [night('2026-12-30', false), night('2026-12-31', false), night('2027-01-01', true), night('2027-01-02', true)], total: 45600,
    }, zone);
  });
});

test('holdout: day arithmetic is the same in every zone', () => {
  eachZone(zone => {
    const later = (date, n) => formatDate(addDays(parseDate(date), n));
    const nights = (from, to) => nightsBetween(parseDate(from), parseDate(to));
    assert.equal(later('2026-03-07', 1), '2026-03-08', zone);
    assert.equal(later('2026-03-08', 1), '2026-03-09', zone);
    assert.equal(later('2026-10-31', 1), '2026-11-01', zone);
    assert.equal(later('2026-11-01', 1), '2026-11-02', zone);
    assert.equal(later('2026-04-05', 1), '2026-04-06', zone);
    assert.equal(later('2026-09-27', -1), '2026-09-26', zone);
    assert.equal(later('2028-02-28', 1), '2028-02-29', zone);
    assert.equal(later('2028-02-28', 2), '2028-03-01', zone);
    assert.equal(later('2026-12-31', 1), '2027-01-01', zone);
    assert.equal(later('2027-01-01', -1), '2026-12-31', zone);
    assert.equal(later('2026-03-01', 245), '2026-11-01', zone);
    assert.equal(nights('2026-03-01', '2026-11-01'), 245, zone);
    assert.equal(nights('2026-03-07', '2026-03-10'), 3, zone);
    assert.equal(nights('2026-10-31', '2026-11-02'), 2, zone);
    assert.equal(nights('2026-04-04', '2026-04-06'), 2, zone);
    assert.equal(nights('2026-09-26', '2026-09-28'), 2, zone);
    assert.equal(nights('2028-02-28', '2028-03-01'), 2, zone);
    assert.equal(nights('2026-12-31', '2027-01-01'), 1, zone);
  });
});
