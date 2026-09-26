/** Cents rounded to the nearest whole cent, halves up, as tax is. */
export const roundCents = amount => Math.round(amount);

/** A percent of whole cents, rounded down to the cent, as discounts are. */
export const percentOf = (cents, percent) => Math.floor(cents * percent / 100);
