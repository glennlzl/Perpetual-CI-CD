import { addDays, dayLabel, formatDate, isWeekendNight, nightsBetween, parseDate } from './dates.js';

/**
 * A stay's price in cents: each night from check-in up to check-out, Friday and Saturday nights at the weekend rate
 * and the others at the weekday rate.
 */
export function quoteStay({ checkIn, checkOut, rates }) {
  const start = parseDate(checkIn), nights = nightsBetween(start, parseDate(checkOut));
  if (nights < 1) throw new RangeError('A stay is at least one night.');
  const lines = Array.from({ length: nights }, (_, index) => {
    const night = addDays(start, index), weekend = isWeekendNight(night);
    return { night: formatDate(night), weekend, cents: weekend ? rates.weekend : rates.weekday };
  });
  return { nights, lines, total: lines.reduce((sum, line) => sum + line.cents, 0) };
}

/** A stay as the booking page shows it: 'Fri 6 Mar – Mon 9 Mar (3 nights)'. */
export function formatStay({ checkIn, checkOut }) {
  const start = parseDate(checkIn), end = parseDate(checkOut), nights = nightsBetween(start, end);
  return `${dayLabel(start)} – ${dayLabel(end)} (${nights} ${nights === 1 ? 'night' : 'nights'})`;
}
