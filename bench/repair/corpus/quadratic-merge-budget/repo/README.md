# contacts

Merges imported contact rows (`name`, `email`, `phone`, `company`), such as CSV exports from several tools, into one
contact per person: `mergeContacts(rows)`.

- Two rows are the same person when their email keys match (`emailKey(email)`): the address trimmed and lower-cased;
  at gmail.com and googlemail.com also without dots or a `+tag` before the `@`, and at gmail.com.
- The first row of each person is kept, in input order. Each of its empty fields is filled from the person's first later
  row that has one; fields that have a value are never overwritten.
- Imports of 150,000 rows finish within 2 seconds (`test/budget.test.js`).
