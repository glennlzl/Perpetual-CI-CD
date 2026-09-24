import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.mjs';
import { DISCOVERY_VERSION } from '../src/scanner.mjs';

const SHA = 'cb9292c4b1f6a0d3e2c1b0a9f8e7d6c5b4a39281';
const session = login => ({ available: true, authenticated: true, account: { login, name: null } });

// Injected GitHub seams: a sign-in manager and a runs reader that record calls
// instead of spawning gh.
function github({ pending = false, sessions = [session('glennlzl')] } = {}) {
  const calls = { session: 0, reads: [] };
  let index = 0;
  return {
    calls,
    auth: { isPending: () => pending, dispose() {}, start() { throw new Error('unused'); }, status() { throw new Error('unused'); }, cancel() { throw new Error('unused'); } },
    runs: {
      async session() { calls.session++; return sessions[Math.min(index++, sessions.length - 1)]; },
      async read(input) { calls.reads.push(input); return { repository: input.repository, sha: input.sha, runs: [] }; },
    },
  };
}

async function start(t, { connection, seams = github() } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-github-runs-')), dataDir = join(dir, 'data');
  await mkdir(dataDir);
  const scan = { discoveryVersion: DISCOVERY_VERSION, repo: { path: dir, name: 'storefront', sha: SHA, branch: 'main', remote: 'https://github.com/acme/storefront.git' }, nodes: [], edges: [], services: [], workflows: [], warnings: [], scannedAt: '2026-09-23T10:00:00.000Z' };
  const state = { scan, providers: [], pipelines: {}, ...(connection === undefined ? {} : { githubConnection: connection }) };
  await writeFile(join(dataDir, 'state.json'), JSON.stringify({ schema: 1, state }));
  const app = await startServer({ port: 0, repo: dir, dataDir, github: seams });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const read = async (repoPath = dir) => {
    const response = await fetch(`${app.url}/api/github/runs?${new URLSearchParams({ repoPath })}`);
    return { status: response.status, body: await response.json() };
  };
  return { read, calls: seams.calls };
}
const connected = { login: 'glennlzl', connectedAt: '2026-09-23T09:00:00.000Z' };

test('the runs route is scoped to the active source before any GitHub read', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-github-runs-'));
  const app = await startServer({ port: 0, repo: dir, dataDir: join(dir, 'data') });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const response = await fetch(`${app.url}/api/github/runs?${new URLSearchParams({ repoPath: '/another/checkout' })}`);
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /active repository changed/);
});

test('a connected account reads runs for the scanned commit as that account', async t => {
  const f = await start(t, { connection: connected });
  const result = await f.read();
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { repository: 'acme/storefront', sha: SHA, runs: [] });
  assert.deepEqual(f.calls.reads, [{ repository: 'acme/storefront', sha: SHA, login: 'glennlzl' }]);
  assert.equal((await f.read('/another/checkout')).status, 409);
  assert.equal(f.calls.reads.length, 1);
});

test('an explicit Disconnect refuses without asking gh for a session or reading runs', async t => {
  const f = await start(t, { connection: null });
  const result = await f.read();
  assert.equal(result.status, 400);
  assert.match(result.body.error, /Connect your GitHub account/);
  assert.equal(f.calls.session, 0);
  assert.deepEqual(f.calls.reads, []);
});

test('a gh account other than the connected login is refused', async t => {
  const f = await start(t, { connection: connected, seams: github({ sessions: [session('someone-else')] }) });
  const result = await f.read();
  assert.equal(result.status, 400);
  assert.match(result.body.error, /Connect your GitHub account/);
  assert.equal(f.calls.session, 1);
  assert.deepEqual(f.calls.reads, []);
});

test('the account is re-verified on every read, so gh auth switch or logout stops the next read', async t => {
  const signedOut = { available: true, authenticated: false, account: null, message: 'Sign in with gh auth login --hostname github.com.' };
  const f = await start(t, { connection: connected, seams: github({ sessions: [session('glennlzl'), session('someone-else'), signedOut] }) });
  assert.equal((await f.read()).status, 200);
  assert.equal((await f.read()).status, 400, 'After gh auth switch the next read is refused.');
  const loggedOut = await f.read();
  assert.equal(loggedOut.status, 400);
  assert.match(loggedOut.body.error, /gh auth login/);
  assert.equal(f.calls.session, 3);
  assert.equal(f.calls.reads.length, 1);
});

test('a pending GitHub sign-in answers 409 before any session or runs read', async t => {
  const f = await start(t, { connection: connected, seams: github({ pending: true }) });
  const result = await f.read();
  assert.equal(result.status, 409);
  assert.match(result.body.error, /Finish or cancel GitHub sign-in/);
  assert.equal(f.calls.session, 0);
  assert.deepEqual(f.calls.reads, []);
});

test('a legacy state without a connection record reuses the verified local session', async t => {
  const f = await start(t);
  assert.equal((await f.read()).status, 200);
  assert.deepEqual(f.calls.reads, [{ repository: 'acme/storefront', sha: SHA, login: 'glennlzl' }]);
});
