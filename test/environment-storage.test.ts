import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createEnvironmentManager } from '../src/environments/manager.ts';

const execute = promisify(execFile);

async function storageFixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'perpetual-storage-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repoPath = path.join(root, 'repo');
  await mkdir(repoPath);
  await writeFile(path.join(repoPath, 'app.mjs'), 'export const application = "original";\n');
  return { root, repoPath };
}

test('manager creates real source snapshots through a data-directory alias and preserves saved state', async t => {
  const { root, repoPath } = await storageFixture(t);
  const systemTemp = await mkdtemp('/tmp/perpetual-storage-data-');
  t.after(() => rm(systemTemp, { recursive: true, force: true }));
  await mkdir(path.join(root, 'actual'));
  await symlink(path.join(root, 'actual'), path.join(root, 'alias'));
  const dataDir = path.join(root, 'alias', 'data');
  const input = {
    dataDir, repoPath,
    managerUrl: new URL('../src/environments/manager.ts', import.meta.url).href,
    runtimeUrl: new URL('../src/environments/runtime.ts', import.meta.url).href,
    plansUrl: new URL('../src/environments/plans.ts', import.meta.url).href,
  };
  // Isolate the twin boundary in a child process. The real manager still creates
  // its directory, the real snapshot consumer copies source, and state persists
  // to disk. This contract test does not start Docker or certify app readiness.
  const script = String.raw`
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import { readFile, realpath, lstat } from 'node:fs/promises';
    import { setTimeout as delay } from 'node:timers/promises';
    import { join } from 'node:path';
    const input = JSON.parse(process.argv[1]);
    const { snapshotSource } = await import(input.plansUrl);
    const unexpected = async () => { throw new Error('Unexpected external twin operation'); };
    let copiedContent;
    mock.module(input.runtimeUrl, { namedExports: {
      prepareEnvironment: async ({ repoPath, directory }) => {
        const source = join(directory, 'source');
        const snapshot = await snapshotSource(repoPath, source);
        copiedContent = await readFile(join(source, 'app.mjs'), 'utf8');
        return { status: 'ready', step: 'Storage contract fixture only', snapshot, services: [], apps: [] };
      },
      environmentHealth: unexpected, environmentLogs: unexpected,
      destroySandbox: unexpected,
    }});
    const { createEnvironmentManager } = await import(input.managerUrl);
    let manager = await createEnvironmentManager({ dataDir: input.dataDir });
    const context = { key: 'source:main', stageId: 'beta', scan: { repo: { path: input.repoPath, sha: 'fixture-sha' }, services: [] } };
    await manager.savePlan(context, { services: {}, apps: { app: { directory: '.', start: 'node app.mjs', port: 3000 } } });
    const { environment } = await manager.create(context);
    const stateFile = join(input.dataDir, 'environments', 'state.json');
    let saved;
    for (let attempt = 0; attempt < 200; attempt++) {
      saved = JSON.parse(await readFile(stateFile, 'utf8')).environments.find(item => item.id === environment.id);
      if (['ready', 'failed'].includes(saved?.status)) break;
      await delay(5);
    }
    await manager.close();
    assert.equal(saved.status, 'ready', saved.error);
    assert.equal(copiedContent, 'export const application = "original";\n');
    assert.equal(saved.snapshot.files, 1);
    assert.match(saved.snapshot.hash, /^[a-f0-9]{64}$/);
    assert.equal(saved.sourceRevision, 'fixture-sha');
    const canonicalRoot = await realpath(join(input.dataDir, 'environments'));
    assert.ok((await lstat(join(canonicalRoot, environment.id, 'source'))).isDirectory(), 'A ready twin keeps the snapshot its apps run from.');
    manager = await createEnvironmentManager({ dataDir: input.dataDir });
    assert.equal((await manager.view(context)).environments[0].snapshot.hash, saved.snapshot.hash);
    await manager.close();
    mock.restoreAll();
  `;
  for (const directory of [dataDir, path.join(systemTemp, 'data')]) {
    const result = await execute(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '--eval', script, JSON.stringify({ ...input, dataDir: directory })], { timeout: 10000, maxBuffer: 64 * 1024 });
    assert.equal(result.stdout, '');
  }
  assert.equal(await readFile(path.join(repoPath, 'app.mjs'), 'utf8'), 'export const application = "original";\n');
  assert.deepEqual(await readdir(repoPath), ['app.mjs']);
});

test('manager continues rejecting an explicitly linked environments storage directory', async t => {
  const { root } = await storageFixture(t);
  const dataDir = path.join(root, 'data'), unrelated = path.join(root, 'unrelated');
  await mkdir(dataDir);
  await mkdir(unrelated);
  await symlink(unrelated, path.join(dataDir, 'environments'));
  await assert.rejects(createEnvironmentManager({ dataDir }), /must not be a symbolic link/);
  assert.deepEqual(await readdir(unrelated), []);
});
