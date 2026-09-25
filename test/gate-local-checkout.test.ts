import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertCheckoutAt } from '../src/gate/checkout.ts';

// A twin copies a local checkout as it is on disk, so a gate reports on a commit only from a clean checkout at it.
test('a gate builds a twin from a local checkout only while it is clean and at the gate\'s commit', async t => {
  const repo = await mkdtemp(join(tmpdir(), 'perpetual-gate-checkout-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  await writeFile(join(repo, 'server.js'), 'send("FIXED")\n');
  git('add', '.'); git('commit', '--quiet', '-m', 'first');
  const first = git('rev-parse', 'HEAD');
  await assertCheckoutAt(repo, first);
  // Files the snapshot never copies do not count: Perpetual's own storage, installed packages and env files.
  await mkdir(join(repo, '.perpetual'), { recursive: true }); await writeFile(join(repo, '.perpetual', 'state.json'), '{}');
  await mkdir(join(repo, 'node_modules', 'x'), { recursive: true }); await writeFile(join(repo, 'node_modules', 'x', 'index.js'), '');
  await writeFile(join(repo, '.env'), 'SECRET=1\n');
  await assertCheckoutAt(repo, first);
  const dirty = /uncommitted changes, which a twin would copy/;
  await writeFile(join(repo, 'server.js'), 'send("BROKEN")\n');
  await assert.rejects(assertCheckoutAt(repo, first), dirty, 'An edit of a tracked file.');
  git('checkout', '--quiet', '--', 'server.js');
  await writeFile(join(repo, 'extra.js'), 'export {};\n');
  await assert.rejects(assertCheckoutAt(repo, first), dirty, 'A new file the snapshot would copy.');
  git('add', 'extra.js'); git('commit', '--quiet', '-m', 'second');
  await assert.rejects(assertCheckoutAt(repo, first), new RegExp(`The checkout is at ${git('rev-parse', 'HEAD').slice(0, 7)}, not ${first.slice(0, 7)}`), 'A commit made after the scan.');
  await assert.rejects(assertCheckoutAt(join(repo, 'missing'), first), /The checkout is at no commit/);
});
