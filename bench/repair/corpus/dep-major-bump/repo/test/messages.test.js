import test from 'node:test';
import assert from 'node:assert/strict';
import { notice } from '../src/messages.js';

test('a welcome notice names the customer', () => {
  assert.equal(notice('welcome', { name: 'Ada' }), 'Welcome to Acme, Ada!');
});

test('a renewal notice with a note', () => {
  assert.equal(notice('renewal', { name: 'Ada', plan: 'Pro', date: '2026-02-01', note: ' Thanks for staying!' }), 'Hi Ada, your Pro plan renews on 2026-02-01. Thanks for staying!');
});
