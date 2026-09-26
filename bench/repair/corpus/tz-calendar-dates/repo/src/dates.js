// Calendar dates: 'YYYY-MM-DD' strings, and the Date values stays are computed with.

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = number => String(number).padStart(2, '0');

/** The Date of a 'YYYY-MM-DD' calendar date; anything else throws a RangeError. */
export function parseDate(text) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(text) : new Date(NaN);
  if (Number.isNaN(date.getTime())) throw new RangeError(`Not a calendar date: ${text}`);
  return date;
}

/** 'YYYY-MM-DD' for a Date that parseDate or addDays returned. */
export function formatDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The calendar date n days after date; n may be negative. */
export function addDays(date, n) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
}

/** Nights from check-in to check-out. */
export function nightsBetween(checkIn, checkOut) {
  return Math.floor((checkOut - checkIn) / DAY_MS);
}

/** A short label such as 'Fri 6 Mar'. */
export function dayLabel(date) {
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/** Friday and Saturday nights are weekend nights. */
export function isWeekendNight(date) {
  return date.getDay() === 5 || date.getDay() === 6;
}
