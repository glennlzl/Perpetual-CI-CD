import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnvironmentManager } from '../src/environments/manager.ts';
import type { EnvironmentRecord, ManagedRuntime } from '../src/environments/manager.ts';

// What a journey gate reads before it moves a pipeline's source: a create admitted but not yet recorded, and a twin whose
// preparation still reads the checkout, which generating a twin config or building a generated one does until it settles.
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const ready = { status: 'ready', services: [], apps: [{ id: 'app', url: 'http://host.docker.internal:50123' }] } satisfies Partial<EnvironmentRecord>;

test('a create is admitting until its record exists, and a twin whose preparation reads the checkout says so until it settles', async t => {
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'perpetual-source-reads-'))), repo = join(dataDir, 'repo');
  await mkdir(repo);
  await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { express: '1.0.0' }, scripts: { start: 'node app.mjs' } }));
  const entered = deferred(), release = deferred();
  const runtime: ManagedRuntime = {
    prepareEnvironment: async ({ environment, onUpdate, generate }) => {
      assert.ok(generate, 'The detected config is generated first.');
      await onUpdate({ sandboxId: environment.id, status: 'preparing' });
      entered.resolve(); await release.promise;
      return structuredClone(ready);
    },
    environmentLogs: async () => '', environmentHealth: async () => ({ status: 'ready' }), destroySandbox: async () => {},
  };
  const manager = await createEnvironmentManager({ dataDir, runtime, authoringModel: async () => ({ apiKey: 'sk-or-v1-fixture', model: 'fixture/model' }) });
  t.after(async () => { release.resolve(); await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  const context = { key: 'local:fixture', stageId: 'gamma', scan: { repo: { path: repo, sha: 'a'.repeat(40), branch: 'main' }, services: [{ id: 'service:web', path: '.', framework: 'Express' }] } };
  assert.equal(manager.admitting(context.key), false);
  const creating = manager.create(context, { generate: true });
  assert.equal(manager.admitting(context.key), true, 'Admitted before its plan is read.');
  assert.equal(manager.admitting('local:other'), false);
  const { environment } = await creating;
  await entered.promise;
  assert.equal(manager.admitting(context.key), false, 'Recorded now, as its summary shows.');
  assert.deepEqual(manager.summaries(context.key).map(item => [item.id, item.status, item.readsCheckout]), [[environment.id, 'preparing', true]]);
  release.resolve();
  const settled = await manager.awaitIdle(environment.id);
  assert.deepEqual([settled.status, 'readsCheckout' in settled], ['ready', false]);
  // A refused create admits nothing.
  await assert.rejects(manager.create({ ...context, stageId: 'delta', scan: { ...context.scan, repo: { ...context.scan.repo, path: join(dataDir, 'missing') } } }));
  assert.equal(manager.admitting(context.key), false);
});
