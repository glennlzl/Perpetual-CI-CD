import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeContacts } from '../../src/merge.js';

const row = (name, email, phone = '', company = '') => ({ name, email, phone, company });

test('holdout: every spelling of a Gmail address is one contact', () => {
  const merged = mergeContacts([
    row('Grace Hopper', 'grace.hopper@gmail.com'),
    row('G. Hopper', '  GraceHopper+navy@GoogleMail.com ', '555-0101', 'US Navy'),
    row('Grace', 'g.r.a.c.e.hopper+cobol@gmail.com', '555-0199', 'Remington Rand'),
  ]);
  assert.deepEqual(merged, [row('Grace Hopper', 'grace.hopper@gmail.com', '555-0101', 'US Navy')]);
});

test('holdout: other domains keep dots and +tags apart', () => {
  const merged = mergeContacts([
    row('Jane', 'jane.doe@example.com'), row('Jane D', 'janedoe@example.com'), row('Jane N', 'jane.doe+news@example.com'), row('JANE', ' JANE.DOE@EXAMPLE.COM', '555-0102'),
  ]);
  assert.deepEqual(merged, [row('Jane', 'jane.doe@example.com', '555-0102'), row('Jane D', 'janedoe@example.com'), row('Jane N', 'jane.doe+news@example.com')]);
});

test('holdout: an empty field is filled from the first later row that has it, and never overwritten', () => {
  const merged = mergeContacts([
    row('', 'lin@example.org', '', 'Initech'),
    row('Lin', 'Lin@Example.org', '', 'Globex'),
    row('Lin Chen', 'lin@example.org', '555-0103', ''),
    row('L. Chen', 'LIN@example.org', '555-0104', 'Hooli'),
  ]);
  assert.deepEqual(merged, [row('Lin', 'lin@example.org', '555-0103', 'Initech')]);
});

test('holdout: contacts come out in the order people first appear', () => {
  const emails = ['mo@example.com', 'cy@example.com', 'xu@example.com', 'al@example.com'];
  const merged = mergeContacts([...emails, ...emails.toReversed()].map((email, index) => row(`#${index}`, email)));
  assert.deepEqual(merged.map(contact => contact.name), ['#0', '#1', '#2', '#3']);
});
