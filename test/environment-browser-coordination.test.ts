import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createBrowserManager } from '../src/browser/manager.ts';
import { createEnvironmentManager } from '../src/environments/manager.ts';
import { createEnvironmentUsage } from '../src/environments/usage.ts';
import { draftCode, manual } from './fixtures/journey-code.ts';
import type { EnvironmentManager, ManagedRuntime } from '../src/environments/manager.ts';

const deferred = () => { let resolve!: () => void, reject!: (reason?: unknown) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
type Deferred = ReturnType<typeof deferred>;
type Call = { operation: string; environmentId?: string; sandboxId?: string };
type Hold = { entered: Deferred; gate: Deferred; error?: string };
const browserCase = { id: 'journey', name: 'Save workspace', goal: 'Save and reopen the workspace',
  steps: [{ id: 'save', title: 'Save the workspace' }, { id: 'reopen', title: 'Reopen the saved workspace' }],
  expectedOutcomes: ['Saved workspace is visible'], assertions: [{ type: 'text-visible', value: 'Workspace' }], selected: true, needsReview: false };
const plan = { services: {}, apps: { app: { directory: '.', start: 'node app.mjs', port: 3000 } } };

async function waitFor<T>(read: () => T | Promise<T>, message: string): Promise<NonNullable<T>> {
  for (let attempt = 0; attempt < 500; attempt++) { const result = await read(); if (result) return result; await delay(2); }
  throw new Error(message);
}

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpetual-cross-manager-'));
  const repo = join(dataDir, 'repo'); await mkdir(repo); await writeFile(join(repo, 'app.mjs'), 'export const workspace = true;');
  const usage = createEnvironmentUsage(), workers: { input: unknown; event: unknown; gate: Deferred }[] = [], calls: Call[] = [], holds = new Map<string, Hold>(), environmentManagers: EnvironmentManager[] = [];
  const context = { key: 'fixture', stageId: 'beta', scan: { repo: { path: repo, sha: 'fixture-revision', branch: 'main' }, services: [] } };
  const gamma = { ...context, stageId: 'gamma' }, delta = { ...context, stageId: 'delta' }, external = { ...context, stageId: 'external' };
  // Both are opened below, before anything but cleanup uses them.
  let browser!: Awaited<ReturnType<typeof createBrowserManager>>, environments!: EnvironmentManager, nextPort = 50120;
  t.after(async () => {
    for (const hold of holds.values()) hold.gate.resolve();
    for (const worker of workers) worker.gate.resolve();
    await browser?.close();
    for (const manager of environmentManagers) await manager.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  async function perform(operation: string, environmentId: string, call: Call = { operation, environmentId }) {
    calls.push(call);
    const hold = holds.get(`${operation}:${environmentId}`);
    if (hold) { hold.entered.resolve(); await hold.gate.promise; if (hold.error) throw new Error(hold.error); }
  }
  const environmentRuntime: ManagedRuntime = {
    async prepareEnvironment({ environment, onUpdate }) {
      await onUpdate({ sandboxId: environment.id });
      return { status: 'ready', services: [], apps: [{ id: 'app', url: `http://127.0.0.1:${nextPort++}/` }] };
    },
    async environmentHealth({ environment }) { await perform('health', environment.id); return { status: 'ready' }; },
    async destroySandbox({ environment }) { await perform('destroy', environment.id, { operation: 'destroy', sandboxId: environment.sandboxId }); },
    environmentLogs: async () => '',
  };
  async function openEnvironmentManager() {
    environments = await createEnvironmentManager({ dataDir, usage, runtime: environmentRuntime });
    environmentManagers.push(environments);
  }
  await openEnvironmentManager();
  async function createReady(scope: typeof context) {
    await environments.savePlan(scope, plan);
    const { environment } = await environments.create(scope);
    const ready = await environments.awaitIdle(environment.id); assert.equal(ready.status, 'ready'); return ready;
  }
  const environment = await createReady(context), independent = await createReady(delta);
  const browserRuntime = {
    capabilities: async () => ({ runtimeInstalled: true, browserInstalled: true, modelConfigured: true }),
    start(input: unknown, event: unknown) {
      const gate = deferred(); workers.push({ input, event, gate });
      return { promise: gate.promise, cancel: () => gate.resolve() };
    },
  };
  // One fake serves discovery (the browser agent) and runs (Playwright code).
  browser = await createBrowserManager({ dataDir, usage, runtime: browserRuntime, playwright: browserRuntime, resolveEnvironment: url => environments.resolveTarget(url),
    onEnvironmentUncertain: (id, error) => environments.markUsageUncertain(id, error) });
  const targetUrl = environment.apps[0].url.replace('127.0.0.1', 'localhost');
  for (const scope of [context, gamma, external]) {
    await browser.saveConfig(scope, { targetUrl: scope === external ? 'https://preview.example.test/' : targetUrl });
    await browser.saveCases(scope, [browserCase]); await draftCode(browser, scope, [browserCase]);
  }
  async function startBrowser(scope = context) {
    const workerIndex = workers.length, { run } = await browser.run(scope, {}, manual);
    const worker = await waitFor(() => workers[workerIndex], 'Browser runtime did not start');
    return { run, worker, scope };
  }
  async function finishBrowser(execution: Awaited<ReturnType<typeof startBrowser>>, result = 'cancelled') {
    const { run, worker, scope } = execution;
    if (result === 'cancelled') await browser.stop(scope, run.id);
    else worker.gate.reject(new Error('Browser transport failed'));
    const terminal = await waitFor(async () => {
      const { run: current } = await browser.runProgress(scope, run.id);
      return !['queued', 'running'].includes(current.status) && (!run.environmentId || !usage.isBusy(run.environmentId)) ? current : null;
    }, 'Browser result or environment lease did not settle');
    assert.equal(terminal.status, result);
    return terminal;
  }
  function hold(operation: string, environmentId = environment.id, error?: string) {
    const value: Hold = { entered: deferred(), gate: deferred(), error }; holds.set(`${operation}:${environmentId}`, value); return value;
  }
  return { browser, environments, environment, independent, context, gamma, delta, external, usage, calls, hold, startBrowser, finishBrowser };
}

for (const sameStage of [true, false]) test(`browser manager ${sameStage ? 'in its own stage' : 'from another stage'} excludes environment deletion and health checks`, async t => {
  const f = await fixture(t);
  const execution = await f.startBrowser(sameStage ? f.context : f.gamma);
  assert.equal(execution.run.environmentId, f.environment.id);
  await assert.rejects(f.environments.destroy(f.context, f.environment.id), { statusCode: 409 });
  await assert.rejects(f.browser.run(sameStage ? f.gamma : f.context, {}, manual), { statusCode: 409 });
  await f.environments.tick();
  assert.equal((await f.environments.view(f.context)).environments[0].status, 'ready');
  assert.deepEqual(f.calls, [{ operation: 'health', environmentId: f.independent.id }], 'The busy environment skips its health check.');
  await f.finishBrowser(execution);
  await f.environments.destroy(f.context, f.environment.id); await f.environments.awaitIdle(f.environment.id);
  await assert.rejects(f.browser.run(f.gamma, {}, manual), /not ready|available/);
});

test('a pending health check blocks browser journeys while external URLs and independent environments remain usable', async t => {
  const f = await fixture(t), hold = f.hold('health');
  const ticking = f.environments.tick(); await hold.entered.promise;
  await assert.rejects(f.browser.run(f.context, {}, manual), { statusCode: 409 });
  await assert.rejects(f.browser.run(f.gamma, {}, manual), { statusCode: 409 });
  const external = await f.startBrowser(f.external); assert.equal(external.run.environmentId, undefined);
  await f.finishBrowser(external);
  await f.environments.destroy(f.delta, f.independent.id);
  assert.equal((await f.environments.awaitIdle(f.independent.id)).status, 'destroyed');
  hold.gate.resolve(); await ticking;
  const owned = await f.startBrowser(f.gamma); await f.finishBrowser(owned);
});

test('pending environment deletion blocks both browser stages and a deletion failure retains ownership', async t => {
  const f = await fixture(t), hold = f.hold('destroy', f.environment.id, 'Cleanup transport failed');
  await f.environments.destroy(f.context, f.environment.id); await hold.entered.promise;
  await assert.rejects(f.browser.run(f.context, {}, manual), { statusCode: 409 });
  await assert.rejects(f.browser.run(f.gamma, {}, manual), { statusCode: 409 });
  const external = await f.startBrowser(f.external); await f.finishBrowser(external);
  hold.gate.resolve();
  const settled = await f.environments.awaitIdle(f.environment.id);
  assert.equal(settled.status, 'cleanup_failed'); assert.match(settled.error!, /Cleanup transport failed/);
  assert.equal(settled.sandboxId, f.environment.sandboxId);
  await assert.rejects(f.browser.run(f.context, {}, manual), { statusCode: 409 });
});

test('browser transport failure records failure before releasing the environment for deletion', async t => {
  const f = await fixture(t), execution = await f.startBrowser(f.gamma);
  const result = await f.finishBrowser(execution, 'failed'); assert.match(result.error!, /Browser transport failed/);
  const next = await f.startBrowser(f.context); await f.finishBrowser(next);
  await f.environments.destroy(f.context, f.environment.id);
  assert.equal((await f.environments.awaitIdle(f.environment.id)).status, 'destroyed');
});

test('unconfirmed browser cleanup quarantines the shared target while allowing owned deletion', async t => {
  const f = await fixture(t), execution = await f.startBrowser(f.gamma);
  execution.worker.gate.reject(Object.assign(new Error('Cleanup incomplete after forced termination.'), { cleanupIncomplete: true }));
  await waitFor(async () => {
    const { run } = await f.browser.runProgress(f.gamma, execution.run.id);
    return run.status === 'failed' && !f.usage.isBusy(f.environment.id);
  }, 'Browser cleanup failure did not settle its quarantine.');
  const [current] = (await f.environments.view(f.context)).environments;
  assert.equal(current.status, 'cleanup_failed');
  assert.match(current.error!, /Cleanup incomplete/);
  assert.deepEqual(f.browser.interruptedEnvironmentIds(), [f.environment.id]);
  await assert.rejects(f.browser.run(f.context, {}, manual), /ready|cleanup/);
  await f.environments.destroy(f.context, f.environment.id);
  assert.equal((await f.environments.awaitIdle(f.environment.id)).status, 'destroyed');
  assert.ok(f.calls.some(call => call.operation === 'destroy' && call.sandboxId === f.environment.sandboxId));
});
