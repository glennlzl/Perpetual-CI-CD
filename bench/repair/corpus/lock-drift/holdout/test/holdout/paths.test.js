import test from 'node:test';
import assert from 'node:assert/strict';
import { articlePath } from '../../src/index.js';

test('holdout: long titles are cut at a word boundary', () => {
  assert.equal(articlePath(42, 'A very long title that keeps going and going'), '0042-a-very-long-title-that');
});

test('holdout: wide numbers stay whole and accents drop', () => {
  assert.equal(articlePath(123456, 'Über café'), '123456-uber-cafe');
});
