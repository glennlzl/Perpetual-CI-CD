import test from 'node:test';
import assert from 'node:assert/strict';
import { articlePath } from '../src/index.js';

test('an article path pads the number and slugs the title', () => {
  assert.equal(articlePath(7, 'Hello World'), '0007-hello-world');
});
