import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnvironmentManager } from '../src/environments/manager.mjs';
import { createEnvironmentUsage } from '../src/environments/usage.mjs';

// Detected as one app from this Express package's dev script.
const manifest = JSON.stringify({ name: 'web', dependencies: { express: '1.0.0' }, scripts: { dev: 'node app.mjs' } });
const scanned = [{ id: 'service:.', path: '.', framework: 'Express' }];

async function until(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(message);
}

async function fixture(t, runtime = {}) {
  const root = await mkdtemp(join(tmpdir(), 'perpetual-environments-'));
  const repo = join(root, 'repo'), dataDir = join(root, 'data');
  await mkdir(repo);
  await writeFile(join(repo, 'package.json'), manifest);
  const manager = await createEnvironmentManager({ dataDir, runtime: {
    prepareEnvironment: async ({ environment }) => ({ status: 'ready', step: 'Ready', sandboxId: environment.id, services: [], apps: Object.keys(environment.plan.apps).map(id => ({ id, url: 'http://host.docker.internal:43100' })) }),
    environmentHealth: async () => ({ status: 'ready' }),
    ...runtime,
  } });
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const context = { key: `local:${repo}`, stageId: 'beta', scan: { repo: { path: repo, branch: 'main', sha: 'a'.repeat(40) }, services: scanned } };
  await manager.create(context);
  const saved = async () => JSON.parse(await readFile(join(dataDir, 'environments', 'state.json'), 'utf8')).environments[0];
  await until(async () => (await saved())?.status === 'ready', 'environment did not become ready');
  const [environment] = (await manager.view(context)).environments;
  return { context, manager, environment };
}

test('transient health-check errors keep an environment ready until they repeat', async t => {
  let health = async () => ({ status: 'ready' });
  const { manager, context, environment } = await fixture(t, { environmentHealth: (...args) => health(...args) });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const status = async () => (await manager.view(context)).environments[0].status;
  const tick = async () => { t.mock.timers.tick(31_000); await manager.tick(); };

  health = async () => { throw new Error('Docker is slow after the host resumed.'); };
  await tick(); await tick();
  assert.equal(await status(), 'ready');
  health = async () => ({ status: 'ready' });
  await tick();
  health = async () => { throw new Error('Docker is slow after the host resumed.'); };
  await tick(); await tick();
  assert.equal(await status(), 'ready', 'a success resets the failure count');
  await tick();
  assert.equal(await status(), 'failed');
  assert.equal((await manager.view(context)).environments[0].id, environment.id);
  health = async () => ({ status: 'ready' });
  await tick();
  assert.equal(await status(), 'ready', 'a sustained transient failure remains recoverable');
});

test('a stopped supervisor fails the environment on the first health check', async t => {
  const { manager, context } = await fixture(t, { environmentHealth: async () => ({ status: 'failed', error: 'Stopped: service exited (1).', final: true }) });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(31_000);
  await manager.tick();
  const [environment] = (await manager.view(context)).environments;
  assert.equal(environment.status, 'failed');
  assert.match(environment.error, /service exited/);
});

test('an environment reported ready accepts its first operation immediately', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perpetual-environments-'));
  const repo = join(root, 'repo');
  await mkdir(repo);
  await writeFile(join(repo, 'package.json'), manifest);
  const usage = createEnvironmentUsage();
  const manager = await createEnvironmentManager({ dataDir: join(root, 'data'), usage, runtime: {
    prepareEnvironment: async ({ environment }) => ({ status: 'ready', step: 'Ready', sandboxId: environment.id, services: [], apps: [] }),
    destroySandbox: async () => {},
  } });
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const context = { key: `local:${repo}`, stageId: 'beta', scan: { repo: { path: repo }, services: scanned } };
  await manager.create(context);
  // Act on the first observation of "ready", as a polling UI or script would.
  let environment;
  for (let attempt = 0; attempt < 10_000 && environment?.status !== 'ready'; attempt++) {
    [environment] = (await manager.view(context)).environments;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(environment.status, 'ready');
  usage.acquire(context, { environmentId: environment.id, operation: 'browser-run' })();
  await manager.destroy(context, environment.id);
  await until(async () => (await manager.view(context)).environments[0].status === 'destroyed', 'deletion did not finish');
});
