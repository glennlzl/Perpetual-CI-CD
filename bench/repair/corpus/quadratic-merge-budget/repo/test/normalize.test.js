import test from 'node:test';
import assert from 'node:assert/strict';
import { emailKey } from '../src/normalize.js';

test('an email key ignores case and surrounding space', () => {
  assert.equal(emailKey('  Ada@Example.COM '), 'ada@example.com');
});

test('a Gmail key drops dots and +tags, and googlemail.com is gmail.com', () => {
  assert.equal(emailKey('Jane.Doe+news@googlemail.com'), 'janedoe@gmail.com');
});

test('other domains keep their dots and +tags', () => {
  assert.equal(emailKey('jane.doe+news@example.com'), 'jane.doe+news@example.com');
});
