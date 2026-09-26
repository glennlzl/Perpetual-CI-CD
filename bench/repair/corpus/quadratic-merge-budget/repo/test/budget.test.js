// The import budget from the README: merging 150,000 rows finishes within 2 seconds. The merge runs in a child process,
// so a merge over budget is stopped at the budget instead of holding up the run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';

const merge = new URL('../src/merge.js', import.meta.url).href;
const fixtures = new URL('./fixtures/contacts.js', import.meta.url).href;

/** Merges generated rows in a child process: { contacts, people }, or null when the merge ran past budgetMs. */
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

test('merging 150,000 contacts finishes within 2,000 ms', async () => {
  const result = await mergeGenerated({ seed: 2026, count: 150_000, duplicateRate: 0.4 }, 2000);
  if (!result) assert.fail('merging 150,000 contacts did not finish within 2,000 ms');
  assert.equal(result.contacts, result.people);
});
