import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MANUAL, NONE, accountOptions, accountRequest, initialAccount, usesAccount } from '../client/src/lib/test-accounts.js';

// As the browser view lists a ready twin's accounts: no passwords.
const accounts = [{ id: 'owner', label: 'Owner', username: 'owner@example.test' }, { id: 'viewer', label: 'viewer@example.test', username: 'viewer@example.test' }];

test('the account choice defaults to the twin\'s first account, or to none without twin accounts', () => {
  assert.deepEqual(initialAccount(accounts), { choice: 'twin:owner', username: '', password: '' });
  assert.deepEqual(initialAccount([]), { choice: NONE, username: '', password: '' });
  assert.equal(usesAccount(initialAccount(accounts)), true);
  assert.equal(usesAccount(initialAccount([])), false);
  assert.equal(usesAccount({ choice: MANUAL, username: '', password: '' }), true);
});

test('the options list each twin account by label and username, then manual entry and none', () => {
  assert.deepEqual(accountOptions(accounts), [
    { value: 'twin:owner', label: 'Owner', detail: 'owner@example.test' },
    { value: 'twin:viewer', label: 'viewer@example.test', detail: '' },
    { value: MANUAL, label: 'Enter manually', detail: '' },
    { value: NONE, label: 'No account', detail: '' },
  ]);
});

test('a twin account is requested by id only, so no password leaves or enters the client', () => {
  assert.deepEqual(accountRequest({ choice: 'twin:viewer', username: '', password: '' }, accounts), { request: { accountId: 'viewer' } });
  assert.deepEqual(accountRequest({ choice: NONE, username: '', password: '' }, accounts), { request: { accountId: null } });
  assert.deepEqual(accountRequest({ choice: NONE, username: '', password: '' }, []), { request: { accountId: null } });
  // An account the twin no longer lists is not sent.
  assert.deepEqual(accountRequest({ choice: 'twin:owner', username: '', password: '' }, []), { error: 'Choose a test account.' });
});

test('an entered account needs both values and is trimmed like before', () => {
  assert.deepEqual(accountRequest({ choice: MANUAL, username: ' someone@example.test ', password: ' secret ' }, accounts),
    { request: { credentials: { username: 'someone@example.test', password: ' secret ' } } });
  for (const [username, password] of [['', 'secret'], ['  ', 'secret'], ['someone', '']]) {
    assert.deepEqual(accountRequest({ choice: MANUAL, username, password }, accounts), { error: 'Enter a username and password.' });
  }
});

test('the run and generate dialogs choose accounts with the shadcn Select and send only the chosen request', async () => {
  const source = await readFile(new URL('../client/src/BrowserTestingPanel.jsx', import.meta.url), 'utf8');
  assert.match(source, /<Select value=\{account\.choice\} onValueChange=\{choose\}>/);
  assert.match(source, /accountOptions\(accounts\)\.map\(option => <SelectItem /);
  assert.equal(source.match(/<TestAccountFields id="(?:run|generate)" accounts=\{accounts\}/g)?.length, 2);
  assert.match(source, /const accounts = data\.accounts \|\| \[\];/);
  assert.doesNotMatch(source, /accounts[^\n]*\.password/, 'Twin accounts carry no password to read.');
});
