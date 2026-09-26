/** A URL slug: lower-case ASCII words joined by hyphens, so 'Café Crème 2L' is 'cafe-creme-2l'. */
export function slugify(text: string): string {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
