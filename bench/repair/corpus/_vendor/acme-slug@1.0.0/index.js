/** A URL slug: accents dropped, lower case, each run of other characters one hyphen, no hyphen at either end. */
export function slugify(text) {
  return String(text).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
