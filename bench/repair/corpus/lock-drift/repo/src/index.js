import { pad } from 'acme-pad';
import { slugify } from 'acme-slug';

/** An article's path: its number padded to four digits, then its title's slug of at most 24 characters. */
export const articlePath = (number, title) => `${pad(number, 4)}-${slugify(title, { maxLength: 24 })}`;
