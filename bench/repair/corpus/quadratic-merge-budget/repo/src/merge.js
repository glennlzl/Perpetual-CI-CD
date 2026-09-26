import { emailKey } from './normalize.js';

/**
 * Merges imported rows into one contact per person, as the README describes: rows whose emails have the same emailKey
 * are one person. The first row of each person is kept, in input order, and each of its empty fields is filled from the
 * person's first later row that has one. The rows passed in are not changed.
 */
export function mergeContacts(rows) {
  const contacts = [];
  for (const row of rows) {
    const existing = contacts.find(contact => emailKey(contact.email) === emailKey(row.email));
    if (!existing) {
      contacts.push({ ...row });
      continue;
    }
    for (const [field, value] of Object.entries(row)) if (value && !existing[field]) existing[field] = value;
  }
  return contacts;
}
