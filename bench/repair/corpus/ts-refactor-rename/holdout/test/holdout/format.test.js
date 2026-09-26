import test from 'node:test';
import assert from 'node:assert/strict';
import { greeting, mention } from '../../dist/format.js';

test('holdout: an unknown id is greeted as a guest', () => {
  assert.equal(greeting('nobody'), 'Hello, guest!');
  assert.equal(greeting('u2'), 'Hello, Grace Hopper!');
});

test('holdout: a mention uses the display name', () => {
  assert.equal(mention({ id: 'x', displayName: 'Ada Lovelace' }), '@ada');
});
