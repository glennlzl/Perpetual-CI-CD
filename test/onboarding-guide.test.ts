import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// The onboarding guide is what a coding agent runs, so every route and command it names must exist as written.
test('the onboarding guide names only API routes the controller serves and CLI commands the CLI has', async () => {
  const [guide, server, cli] = await Promise.all([read('docs/onboarding.md'), read('src/server.ts'), read('src/cli.ts')]);
  const routes = [...new Set([...guide.matchAll(/`(?:GET|POST) (\/api\/[\w/-]+)/g)].map(match => match[1]))];
  assert.ok(routes.length >= 10, `The guide drives the controller through its API: ${routes.join(', ')}`);
  const served = (route: string) => server.includes(`'${route}'`)
    // Environment operations are dispatched by the path's last segment.
    || (route.startsWith('/api/environments/') && server.includes(`operation==='${route.slice('/api/environments/'.length)}'`));
  assert.deepEqual(routes.filter(route => !served(route)), []);
  const commands = [...new Set([...guide.matchAll(/node src\/cli\.ts (\w+)/g)].map(match => match[1]))].sort();
  assert.deepEqual(commands, ['serve', 'twin']);
  for (const command of commands) assert.ok(cli.includes(`command==='${command}'`), command);
  // The guide's steps are ordered, and the person is asked before each account, source or environment change.
  for (const step of ['## 1. Start the controller', '## 2. The model key', '## 3. Connect GitHub', '## 4. The target branch', '## 5. What the twin will run', '## 6. Create Beta', '## 7. Hand over']) assert.ok(guide.includes(step), step);
  assert.ok(guide.indexOf('## 3.') < guide.indexOf('## 5.') && guide.indexOf('## 5.') < guide.indexOf('## 6.'));
  // Each question is written out for the agent's own question tool: its text, then its options as a list.
  const questions = [...guide.matchAll(/\*\*Ask:\*\* ([^\n]+)\n\n((?:- [^\n]+\n)+)/g)].map(match => ({ text: match[1], options: match[2].trim().split('\n').length }));
  assert.ok(questions.length >= 6, `Questions: ${questions.map(question => question.text).join(' | ')}`);
  for (const question of questions) assert.ok(question.options >= 2, question.text);
  assert.equal(guide.match(/\*\*Ask:\*\*/g)?.length, questions.length, 'Every question lists its options.');
  for (const text of ['Connect your GitHub account to Perpetual?', 'Which branch should Perpetual gate?', 'Create the Beta environment?']) assert.ok(questions.some(question => question.text.startsWith(text)), text);
});
