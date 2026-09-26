import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeContacts } from '../src/merge.js';

const row = (name, email, phone = '', company = '') => ({ name, email, phone, company });

test('rows of one person merge into the first, whose empty fields are filled', () => {
  const merged = mergeContacts([
    row('Ada Lovelace', 'ada@example.com', '', 'Analytical Engines'),
    row('A. Lovelace', ' ADA@Example.com ', '+44 20 7946 0000', 'Difference Engines'),
  ]);
  assert.deepEqual(merged, [row('Ada Lovelace', 'ada@example.com', '+44 20 7946 0000', 'Analytical Engines')]);
});

test('contacts keep the order of their first rows', () => {
  const merged = mergeContacts([row('Zoe', 'zoe@example.com'), row('Bob', 'bob@example.com'), row('Zoe Z', 'ZOE@example.com', '555-0100')]);
  assert.deepEqual(merged.map(contact => contact.name), ['Zoe', 'Bob']);
});

test('the rows passed in are not changed', () => {
  const rows = [row('Ada', 'ada@example.com'), row('Ada', 'ada@example.com', '555-0100')];
  mergeContacts(rows);
  assert.deepEqual(rows[0], row('Ada', 'ada@example.com'));
});
