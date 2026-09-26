/**
 * A URL slug: accents dropped, lower case, each run of other characters one hyphen, no hyphen at either end. With
 * maxLength, a longer slug is cut at the last hyphen that keeps it within the length, or at the length itself.
 */
export function slugify(text, { maxLength = Infinity } = {}) {
  const slug = String(text).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length <= maxLength) return slug;
  const cut = slug.slice(0, maxLength + 1), end = cut.lastIndexOf('-');
  return (end > 0 ? cut.slice(0, end) : slug.slice(0, maxLength)).replace(/-+$/, '');
}
