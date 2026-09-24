import test from 'node:test';
import assert from 'node:assert/strict';
import { canSwitchBranch, initialBranch, nameParts, normalizedRoot, readsLocalCheckout, rootDirectoryError, sourceChange } from '../client/src/lib/source-selection.js';
import { sourceRoot } from '../src/github-source.mjs';

const roots = [
  '', '/', '  /  ', 'apps/web', '/apps/web', '//apps//web/', ' /apps/web ',
  // Paths the server accepts that an earlier client check rejected.
  '/src/api', '/Users/me/project/src', '~', '~/apps', 'c:tools', 'C:/tools', 'https://example.com/apps', 'file:///etc',
  '.', '..', '/apps/../web', '/apps/./web', '/.git', '/apps/.GIT/hooks', '/apps/.github', '/apps/.gitignore', '/apps/..web',
  'apps\\web', '/apps/\u0007', `/${'a'.repeat(2048)}`, `/${'a'.repeat(2046)}`,
];

test('the Source sheet accepts exactly the root directories the server accepts', () => {
  for (const value of roots) {
    // The sheet sends the trimmed value, or / when it is empty.
    let serverError = '';
    try { sourceRoot(value.trim() || '/'); } catch (error) { serverError = error.message; }
    const clientError = rootDirectoryError(value);
    assert.equal(Boolean(clientError), Boolean(serverError), `${JSON.stringify(value.slice(0, 40))}: client "${clientError}" / server "${serverError}"`);
    if (!serverError) assert.equal(normalizedRoot(value), sourceRoot(value.trim() || '/'));
  }
});

test('a saved or scanned branch that GitHub lacks stays selected instead of the default', () => {
  const names = ['preview', 'main'];
  assert.equal(initialBranch({ previous: 'codex/local-only', preferred: 'codex/local-only', defaultBranch: 'preview', names }), 'codex/local-only');
  assert.equal(initialBranch({ previous: '', preferred: 'codex/local-only', defaultBranch: 'preview', names }), 'codex/local-only');
  assert.equal(initialBranch({ previous: 'main', preferred: 'codex/local-only', defaultBranch: 'preview', names }), 'main');
  assert.equal(initialBranch({ previous: '', preferred: '', defaultBranch: 'preview', names }), 'preview');
  assert.equal(initialBranch({ previous: '', preferred: '', defaultBranch: 'gone', names }), 'preview');
  assert.equal(initialBranch({ names: [] }), '');
});

test('Save needs a change from the current source and a branch GitHub has', () => {
  const current = { repository: 'acme/storefront', branch: 'codex/local-only', rootDirectory: '/' };
  const branches = ['preview', 'main'];
  assert.deepEqual(sourceChange({ current, repository: 'acme/storefront', branch: 'codex/local-only', rootDirectory: '/', branches }), { changed: false, onGitHub: false });
  assert.deepEqual(sourceChange({ current, repository: 'acme/storefront', branch: 'codex/local-only', rootDirectory: '/apps', branches }), { changed: true, onGitHub: false });
  assert.deepEqual(sourceChange({ current, repository: 'acme/storefront', branch: 'preview', rootDirectory: '/', branches }), { changed: true, onGitHub: true });
  const saved = { repository: 'acme/storefront', branch: 'preview', rootDirectory: '/apps/web' };
  assert.equal(sourceChange({ current: saved, repository: 'Acme/Storefront', branch: 'preview', rootDirectory: ' apps//web/ ', branches }).changed, false, 'GitHub names and equivalent roots are the same source');
  assert.equal(sourceChange({ current: null, repository: 'acme/widgets', branch: 'main', rootDirectory: '/', branches }).changed, true, 'Without a current source any valid choice is new');
  assert.equal(sourceChange({ current, repository: 'acme/storefront', branch: '', rootDirectory: '/', branches }).onGitHub, false);
});

test('the canvas reads a managed copy only when the saved source scanned the same path', () => {
  const scanPath = '/data/checkouts/storefront/apps';
  assert.equal(readsLocalCheckout({ repository: 'acme/storefront', branch: 'preview', rootDirectory: '/', scanPath }, scanPath), false);
  assert.equal(readsLocalCheckout({ repository: 'acme/storefront', branch: 'preview', rootDirectory: '/' }, '/Users/me/storefront'), true, 'A source built from the scanned remote has no scan path');
  assert.equal(readsLocalCheckout({ repository: 'acme/storefront', branch: 'preview', rootDirectory: '/', scanPath }, '/Users/me/storefront'), true);
  assert.equal(readsLocalCheckout(null, '/Users/me/storefront'), true);
  assert.equal(readsLocalCheckout(null, ''), false, 'Nothing scanned yet');
});

test('a local checkout can switch to the GitHub copy of its own branch', () => {
  // With no saved source, the connection reports the scanned remote and branch without a scan path.
  const scanned = { repository: 'acme/storefront', branch: 'preview', rootDirectory: '/' };
  const branches = ['preview', 'main'];
  assert.deepEqual(sourceChange({ current: scanned, local: true, repository: 'acme/storefront', branch: 'preview', rootDirectory: '/', branches }), { changed: true, onGitHub: true });
  assert.deepEqual(sourceChange({ current: scanned, local: true, repository: 'Acme/Storefront', branch: 'preview', rootDirectory: ' / ', branches }), { changed: true, onGitHub: true });
  assert.deepEqual(sourceChange({ current: scanned, local: false, repository: 'acme/storefront', branch: 'preview', rootDirectory: '/', branches }), { changed: false, onGitHub: true }, 'The managed copy is already current');
  const localOnly = { ...scanned, branch: 'codex/local-only' };
  assert.deepEqual(sourceChange({ current: localOnly, local: true, repository: 'acme/storefront', branch: 'codex/local-only', rootDirectory: '/', branches }), { changed: false, onGitHub: false }, 'A branch GitHub lacks has no copy to switch to');

  assert.equal(canSwitchBranch({ value: 'preview', branch: 'preview', local: true, branches }), true);
  assert.equal(canSwitchBranch({ value: 'preview', branch: 'preview', local: false, branches }), false);
  assert.equal(canSwitchBranch({ value: 'main', branch: 'preview', local: false, branches }), true);
  assert.equal(canSwitchBranch({ value: 'codex/local-only', branch: 'codex/local-only', local: true, branches }), false);
  assert.equal(canSwitchBranch({ value: 'gone', branch: 'preview', local: true, branches }), false);
  assert.equal(canSwitchBranch({ value: '', branch: '', local: true, branches: [''] }), false);
});

test('long branch names keep their distinctive end', () => {
  assert.deepEqual(nameParts('main'), ['main', '']);
  assert.deepEqual(nameParts('release/2026'), ['release/2026', ''], 'Names within the tail stay whole');
  assert.deepEqual(nameParts('codex/cart-checkout-agent-demo'), ['codex/cart-checkout-', 'agent-demo'], 'The tail starts at a word');
  assert.deepEqual(nameParts('claude/install-skills-check-status-80f674'), ['claude/install-skills-check-', 'status-80f674']);
  assert.deepEqual(nameParts('dependabot/npm_and_yarn/client/vite-5.4.2'), ['dependabot/npm_and_yarn/client/', 'vite-5.4.2']);
  assert.deepEqual(nameParts('featureupdatewithoutseparators'), ['featureupdatewitho', 'utseparators'], 'Without a separator the tail is a fixed length');
  for (const name of ['', 'feature/ünïcödé-branch-🚀-rocket', 'dependabot/npm_and_yarn/client/vite-5.4.2', 'a-bcdefghijklmnop', 'abcdefghijklm-']) {
    assert.equal(nameParts(name).join(''), name);
    const [head, tail] = nameParts(name);
    if (tail) assert.ok(head.length > 0 && [...tail].length >= 8 && [...tail].length <= 16, name);
  }
  assert.equal(nameParts('feature/ünïcödé-branch-🚀-rocket')[1], 'branch-🚀-rocket', 'Code points are never split');
  assert.deepEqual(nameParts(undefined), ['', '']);
});
