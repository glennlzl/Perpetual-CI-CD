import test from 'node:test';
import assert from 'node:assert/strict';
import { greeting, mention } from '../dist/format.js';
import { findUser } from '../dist/users.js';

test('greets a known user by display name', () => {
  assert.equal(greeting('u1'), 'Hello, Ada Lovelace!');
});

test('mentions a user by the first word of the display name', () => {
  assert.equal(mention(findUser('u2')), '@grace');
});
