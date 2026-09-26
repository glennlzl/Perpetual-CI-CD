/** value as text padded on the left with fill to at least width characters; a longer value is kept whole. */
export function pad(value, width, fill = '0') {
  return String(value).padStart(width, fill);
}
