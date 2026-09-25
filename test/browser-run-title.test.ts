import test from 'node:test';
import assert from 'node:assert/strict';
import { browserRunTitle } from '../client/src/lib/browser-test-ui.ts';
test('history identifies saved journeys and handles older unnamed runs honestly', () => {
  assert.equal(browserRunTitle({ mode: 'discover' }), 'Explore product');
  assert.equal(browserRunTitle({ mode: 'run', caseIds: ['a'], caseSummaries: [{ id: 'a', name: 'Save workflow' }] }), 'Save workflow');
  assert.equal(browserRunTitle({ mode: 'run', caseIds: ['a', 'b'], caseSummaries: [{ id: 'a', name: 'Save workflow' }] }), 'Save workflow + 1');
  assert.equal(browserRunTitle({ mode: 'run', caseIds: ['a', 'b'] }), '2 tests');
  assert.equal(browserRunTitle({ mode: 'run' }), 'Test run');
});
