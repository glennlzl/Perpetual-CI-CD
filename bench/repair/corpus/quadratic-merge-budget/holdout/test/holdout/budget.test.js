// The import budget on inputs test/budget.test.js does not use: another seed with more duplicates, and only distinct
// people. Each merge runs in a child process that is stopped at the budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';

const merge = new URL('../../src/merge.js', import.meta.url).href;
const fixtures = new URL('../fixtures/contacts.js', import.meta.url).href;

function mergeGenerated(options, budgetMs) {
  const script = [
    `import { mergeContacts } from ${JSON.stringify(merge)};`,
    `import { generateContacts } from ${JSON.stringify(fixtures)};`,
    `const { rows, people } = generateContacts(${JSON.stringify(options)});`,
    'process.stdout.write(JSON.stringify({ contacts: mergeContacts(rows).length, people }));',
  ].join('\n');
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', script], { timeout: budgetMs }, (error, stdout, stderr) => {
      if (error?.killed) resolve(null);
      else if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(JSON.parse(stdout));
    });
  });
}

test('holdout: 200,000 rows with 70% repeats merge within 2,500 ms', async () => {
  const result = await mergeGenerated({ seed: 977, count: 200_000, duplicateRate: 0.7 }, 2500);
  if (!result) assert.fail('merging 200,000 contacts did not finish within 2,500 ms');
  assert.equal(result.contacts, result.people);
});

test('holdout: 150,000 distinct people merge within 2,500 ms', async () => {
  const result = await mergeGenerated({ seed: 31337, count: 150_000, duplicateRate: 0 }, 2500);
  if (!result) assert.fail('merging 150,000 distinct contacts did not finish within 2,500 ms');
  assert.deepEqual(result, { contacts: 150_000, people: 150_000 });
});
