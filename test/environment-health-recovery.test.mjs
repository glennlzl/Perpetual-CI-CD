import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnvironmentManager } from '../src/environments/manager.mjs';
import { createEnvironmentUsage } from '../src/environments/usage.mjs';

const context = { key: 'health-fixture', stageId: 'beta', scan: { repo: { path: '/fixture/app' }, services: [] } };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

async function fixture(t, { restart = true } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-health-recovery-'));
  const file = join(dataDir, 'environments/state.json'), usage = createEnvironmentUsage(), managers = [];
  const calls = { health: 0, onReady: 0 };
  let health = async () => ({ status: 'failed', final: true, error: 'Stopped: app exited (1).' });
  const runtime = {
    prepareEnvironment: async ({ environment, onUpdate }) => {
      await onUpdate({ sandboxId: environment.id });
      return { status: 'ready', step: 'Ready', services: [], apps: [{ id: 'app', url: 'http://host.docker.internal:50123' }] };
    },
    environmentHealth: async () => { calls.health++; return health(); },
    destroySandbox: async () => { throw new Error('Recovery must not destroy or recreate a twin'); },
  };
  const open = async () => {
    const manager = await createEnvironmentManager({ dataDir, usage, runtime, onReady: () => { calls.onReady++; } });
    managers.push(manager); return manager;
  };
  t.after(async () => { for (const manager of managers) await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  let manager = await open();
  await manager.savePlan(context, { services: {}, apps: { app: { directory: '.', start: 'node app.mjs', port: 3000 } } });
  const { environment } = await manager.create(context);
  await manager.awaitIdle(environment.id);
  await manager.tick();
  assert.equal(manager.resolveTarget('http://localhost:50123/').status, 'failed');
  assert.equal(manager.summaries(context.key)[0].step, 'Unhealthy');
  if (restart) { await manager.close(); manager = await open(); }
  return { manager, open, usage, file, environment, calls, setHealth: operation => { health = operation; } };
}

test('a recovered owned application becomes ready after a health recheck without regenerating cases', async t => {
  const f = await fixture(t);
  f.setHealth(async () => ({ status: 'ready' }));
  await f.manager.tick();
  const recovered = f.manager.resolveTarget('http://localhost:50123/workspace');
  assert.equal(recovered.status, 'ready');
  assert.equal(recovered.step, 'Ready');
  assert.equal(recovered.error, null);
  assert.equal(recovered.id, f.environment.id);
  assert.equal(recovered.sandboxId, f.environment.id);
  assert.equal(f.calls.onReady, 1, 'Rechecking health must not re-run paid discovery.');
  const saved = JSON.parse(await readFile(f.file, 'utf8'));
  assert.equal(saved.environments[0].status, 'ready');
  await f.manager.close();
  assert.equal((await f.open()).resolveTarget('http://localhost:50123/').status, 'ready');
});

test('a health failure can recover in the same controller after the health interval', async t => {
  let time = Date.now(); t.mock.method(Date, 'now', () => time);
  const f = await fixture(t, { restart: false });
  f.setHealth(async () => ({ status: 'ready' }));
  await f.manager.tick(); assert.equal(f.calls.health, 1);
  time += 30000;
  await f.manager.tick();
  assert.equal(f.manager.resolveTarget('http://localhost:50123/').status, 'ready');
  assert.equal(f.calls.health, 2);
});

test('health recovery leaves an actually unhealthy application unavailable', async t => {
  const f = await fixture(t);
  f.setHealth(async () => ({ status: 'failed', error: 'Backend is not ready' }));
  await f.manager.tick();
  assert.equal(f.calls.health, 2, 'The unhealthy application must be rechecked.');
  assert.equal(f.manager.resolveTarget('http://localhost:50123/').status, 'failed');
  assert.equal(f.calls.onReady, 1);
});

test('health recovery never revives cleanup, provisioning, removed or unowned records', async t => {
  const f = await fixture(t); await f.manager.close();
  const saved = JSON.parse(await readFile(f.file, 'utf8')), base = saved.environments[0];
  const overrides = [
    { status: 'cleanup_failed' }, { status: 'destroyed' }, { step: 'Failed' },
    { cleanedAt: new Date().toISOString() }, { plan: undefined }, { sandboxId: undefined },
  ];
  saved.environments = overrides.map((override, index) => ({ ...base, id: `health-exclusion-${index}`, ...override }));
  await writeFile(f.file, JSON.stringify(saved));
  const manager = await f.open(); f.setHealth(async () => ({ status: 'ready' }));
  await manager.tick();
  assert.equal(f.calls.health, 1, 'Only prior ready environments with intact ownership may be rechecked.');
  assert.ok(manager.summaries(context.key).every(item => item.status !== 'ready'));
});

test('health recovery shares exclusion with cross-stage work and stage removal', async t => {
  const f = await fixture(t), entered = deferred(), finish = deferred();
  f.setHealth(async () => { entered.resolve(); await finish.promise; return { status: 'ready' }; });
  const release = f.usage.acquire({ ...context, stageId: 'gamma' }, { environmentId: f.environment.id, operation: 'browser-run' });
  await f.manager.tick(); assert.equal(f.calls.health, 1); release();
  const removal = f.usage.beginRemoval(context, [f.environment.id]);
  await f.manager.tick(); assert.equal(f.calls.health, 1); f.usage.endRemoval(removal);
  const ticking = f.manager.tick();
  // The first await must observe whether recovery started rather than hang when
  // this regression is present.
  await Promise.race([entered.promise, ticking]);
  assert.equal(f.calls.health, 2);
  try {
    assert.throws(() => f.usage.beginRemoval(context, [f.environment.id]), { statusCode: 409 });
    await assert.rejects(f.manager.destroy(context, f.environment.id), { statusCode: 409 });
    assert.throws(() => f.usage.acquire({ ...context, stageId: 'gamma' }, { environmentId: f.environment.id }), { statusCode: 409 });
  } finally { finish.resolve(); await ticking; }
  assert.equal(f.usage.isBusy(f.environment.id), false);
  assert.equal(f.manager.resolveTarget('http://localhost:50123/').status, 'ready');
});

test('a health response cannot overwrite quarantine applied while the probe is running', async t => {
  const f = await fixture(t), entered = deferred(), finish = deferred();
  f.setHealth(async () => { entered.resolve(); await finish.promise; return { status: 'ready' }; });
  const ticking = f.manager.tick(); await Promise.race([entered.promise, ticking]);
  assert.equal(f.calls.health, 2);
  try { await f.manager.markUsageUncertain(f.environment.id, new Error('An earlier guest operation is still uncertain')); }
  finally { finish.resolve(); await ticking; }
  assert.equal(f.manager.resolveTarget('http://localhost:50123/').status, 'cleanup_failed');
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).environments[0].status, 'cleanup_failed');
});

test('failed durable recovery does not expose the application as ready', async t => {
  const f = await fixture(t);
  f.setHealth(async () => ({ status: 'ready' }));
  await rm(f.file); await mkdir(f.file);
  try {
    await assert.rejects(f.manager.tick(), /EISDIR|ENOTEMPTY|rename/);
    assert.equal(f.manager.resolveTarget('http://localhost:50123/').status, 'failed');
    assert.equal(f.usage.isBusy(f.environment.id), false);
    assert.equal(f.calls.onReady, 1);
  } finally { await rm(f.file, { recursive: true }); }
});
