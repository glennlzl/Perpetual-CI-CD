import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, chmod, lstat, rm, rmdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { detectEnvironmentConfig } from './plans.mjs';
import { prepareEnvironment, environmentHealth, environmentLogs, destroySandbox } from './runtime.mjs';
import { redact } from '../providers.mjs';
import { createEnvironmentUsage } from './usage.mjs';
import { validateTwinConfig } from '../twin/index.mjs';
import { HOST } from '../twin/compose.mjs';

const now = () => new Date().toISOString();
const scopeId = ({ key, stageId }) => createHash('sha256').update(`${key}\0${stageId}`).digest('hex');
const FAILURE_TEXT = 1500, FAILURE_HEAD = 300, OMITTED = '\n…\n';
// A long failure keeps its start, which names the step, and its end, where a command reports its error.
const failure = error => {
  const text = redact(String(error.message || error));
  return text.length <= FAILURE_TEXT ? text : `${text.slice(0, FAILURE_HEAD)}${OMITTED}${text.slice(-(FAILURE_TEXT - FAILURE_HEAD - OMITTED.length))}`;
};
const publicEnvironment = ({ scope, plan, logs, origins, ...item }) => item;
// A twin's test accounts as environments keep and show them; passwords stay in the twin's private state.
const publicAccounts = accounts => (Array.isArray(accounts) ? accounts : []).map(({ id, label, username }) => ({ id, label, username }));
const conflict = message => Object.assign(new Error(message), { statusCode: 409 });
const UUID = /^[a-f0-9-]{36}$/;
const HEALTH_FAILURES = 3;
const defaultRuntime = { prepareEnvironment, environmentHealth, environmentLogs, destroySandbox };
const canRecoverHealth = environment => environment.status === 'failed' && environment.step === 'Unhealthy'
  && environment.sandboxId && environment.plan && !environment.cleanedAt;
// Perpetual's browser and the twin's containers reach the host under these names.
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]', HOST];
function targetOrigin(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (LOOPBACK.includes(url.hostname)) url.hostname = '127.0.0.1';
    return url.origin;
  } catch { return null; }
}
// A plan saved before twins listed services with install and start commands; a fresh detection replaces it.
const legacyPlan = plan => Array.isArray(plan?.services);
// Saved state may hold keys of removed features: top-level cases, analyses, runs and
// schedules, and environment twinsToken, activeOperation and desktopUrl. Loading drops them.
// A twin's sandbox id is its environment's id. Any other sandbox is a Cua guest from
// before twins, which only awaits deletion.
function loadedEnvironment({ twinsToken, activeOperation, desktopUrl, serviceOrigins, ...environment }) {
  environment.origins ??= serviceOrigins ?? (environment.services || []).map(service => targetOrigin(service.url)).filter(Boolean);
  if (legacyPlan(environment.plan)) delete environment.plan;
  if (!environment.sandboxId || environment.sandboxId === environment.id) return environment;
  environment.services = [];
  if (['ready', 'failed'].includes(environment.status) && !environment.cleanedAt) Object.assign(environment, { status: 'failed', step: 'Retired', error: 'Delete this environment to remove its Cua guest.' });
  return environment;
}

export async function createEnvironmentManager({ dataDir, onReady, usage = createEnvironmentUsage(), runtime = defaultRuntime, interruptedEnvironmentIds = [] }) {
  const configuredRoot = resolve(dataDir, 'environments');
  await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
  if ((await lstat(configuredRoot)).isSymbolicLink()) throw new Error('Environment storage must not be a symbolic link.');
  // Resolve system aliases such as /tmp and /var before deriving owned snapshot
  // destinations; snapshotSource still rejects an explicitly linked destination.
  const root = await realpath(configuredRoot);
  await chmod(root, 0o700);
  const file = join(root, 'state.json');
  let state = { version: 1, plans: {}, environments: [] };
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw new Error('Invalid environment state.');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    if (saved.version !== 1 || !Array.isArray(saved.environments) || !saved.plans || typeof saved.plans !== 'object') throw new Error('Unsupported environment state.');
    state = { version: 1, plans: Object.fromEntries(Object.entries(saved.plans).filter(([, plan]) => !legacyPlan(plan))), environments: saved.environments.map(loadedEnvironment) };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let saving = Promise.resolve(), closed = false, closing, ticking = false;
  const jobs = new Map(), pending = new Set(), scopesBusy = new Set(), healthChecks = new Map(), healthFailures = new Map(), healthResults = new Map(), healthSkips = new Map();
  // The monitor heartbeat is in-memory observation only; it is never persisted.
  const iso = time => new Date(time).toISOString();
  function withHealth(item) {
    const value = publicEnvironment(item), checked = healthResults.get(item.id), skipped = healthSkips.get(item.id);
    if (!checked && !skipped) return value;
    return { ...value, health: { ...(checked ? { checkedAt: iso(checked.at), ok: checked.ok, consecutiveFailures: healthFailures.get(item.id) || 0 } : {}), ...(skipped ? { skippedInUseAt: iso(skipped) } : {}) } };
  }
  function skipHealth(id) { if (!((healthSkips.get(id) || 0) >= (healthChecks.get(id) || 0))) healthSkips.set(id, Date.now()); }
  const serialized = () => JSON.stringify(state);
  function budget() { if (Buffer.byteLength(serialized()) > 30 * 1024 * 1024) throw new Error('Local metadata storage is full. Export your history and choose a new data directory.'); }
  function persist() {
    const operation = saving.then(async () => {
      budget();
      const temp = join(root, `.state-${randomUUID()}.tmp`);
      await writeFile(temp, serialized(), { mode: 0o600 });
      await rename(temp, file);
    });
    saving = operation.catch(() => {});
    return operation;
  }
  function quarantine(environment, error, step = 'Interrupted operation') {
    if (!environment?.sandboxId || environment.status === 'destroyed' || environment.cleanedAt) return;
    Object.assign(environment, { status: 'cleanup_failed', step, updatedAt: now(), error });
  }
  const interrupted = new Set(interruptedEnvironmentIds);
  for (const item of state.environments) {
    if (['queued', 'creating', 'preparing', 'destroying'].includes(item.status)) Object.assign(item, { status: item.sandboxId ? 'cleanup_failed' : 'failed', step: 'Interrupted', updatedAt: now(), error: 'The controller stopped during this operation. Delete the remaining sandbox before retrying.' });
  }
  // Controller death does not stop application work that an interrupted browser
  // run started. Keep ownership, and require cleanup before accepting reuse.
  for (const environment of state.environments) if (interrupted.has(environment.id)) {
    quarantine(environment, 'The controller stopped while using this environment. Guest work may still be running. Delete the sandbox before retrying.');
  }
  await persist();

  // A twin's apps run from its source snapshot, so the snapshot stays until the twin is gone.
  // The environment's directory goes with it unless a twin that failed cleanup is still there.
  async function removeSnapshot(environment) {
    if (!UUID.test(environment.id)) throw new Error('Invalid environment storage ID.');
    const directory = join(root, environment.id);
    await rm(join(directory, 'source'), { recursive: true, force: true });
    await rmdir(directory).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; });
  }
  function setPlan(scope, value) {
    const previous = state.plans[scope];
    state.plans[scope] = value;
    try { budget(); } catch (error) { if (previous === undefined) delete state.plans[scope]; else state.plans[scope] = previous; throw error; }
  }

  async function planFor(context) {
    const scope = scopeId(context);
    if (!state.plans[scope]) { setPlan(scope, await detectEnvironmentConfig(context.scan)); await persist(); }
    return state.plans[scope];
  }
  function findEnvironment(context, id, { idle = false } = {}) {
    const environment = state.environments.find(item => item.id === id && item.scope === scopeId(context));
    if (!environment) throw new Error('Environment not found in this stage.');
    if (idle && jobs.has(id)) throw conflict('This environment has an operation in progress.');
    return environment;
  }
  function track(task) {
    pending.add(task);
    task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
  }
  function enqueue(id, work, { release = () => {}, onSettled } = {}) {
    if (jobs.has(id)) throw conflict('This environment has an operation in progress.');
    let released = false;
    // A job may release the environment before it finishes; never release a later job's reservation.
    const releaseJob = () => {
      if (released) return;
      released = true;
      if (jobs.get(id) === task) jobs.delete(id);
      release();
    };
    const task = Promise.resolve().then(() => work(releaseJob)).catch(error => {
      process.stderr.write(`Environment operation: ${failure(error)}\n`);
    }).finally(releaseJob);
    jobs.set(id, task);
    // Readiness hands ownership to browser discovery only after the allocation
    // lease is released. Still join that follow-up when the controller closes.
    track(task.then(async () => { if (!closed && onSettled) await onSettled(); }));
  }
  const manager = {
    summaries(key) { return state.environments.filter(item => item.pipelineKey === key).map(withHealth); },
    resolveTarget(url) {
      const origin = targetOrigin(url);
      if (!origin) return null;
      const environment = state.environments.find(item => (item.origins || []).includes(origin));
      return environment ? structuredClone(publicEnvironment(environment)) : null;
    },
    markUsageUncertain(id, error) {
      const environment = state.environments.find(item => item.id === id);
      if (!environment) return Promise.reject(new Error('Environment not found.'));
      quarantine(environment, `Environment use did not confirm completion. Delete the sandbox before retrying. ${failure(error)}`, 'Uncertain environment operation');
      // This settles already admitted work, including browser cleanup during
      // shutdown. A failed save must leave the in-memory quarantine in place.
      return track(persist());
    },
    async awaitIdle(id) {
      while (jobs.has(id)) await jobs.get(id);
      const environment = state.environments.find(item => item.id === id);
      if (!environment) throw new Error('Environment not found.');
      return structuredClone(publicEnvironment(environment));
    },
    async view(context) {
      const scope = scopeId(context), plan = await planFor(context);
      return { environments: state.environments.filter(item => item.scope === scope).map(withHealth), plan };
    },
    async savePlan(context, plan) {
      const config = validateTwinConfig(plan);
      setPlan(scopeId(context), config);
      await persist();
      return { plan: config };
    },
    async create(context) {
      context = structuredClone(context);
      const scope = scopeId(context);
      if (scopesBusy.has(scope) || state.environments.some(item => item.scope === scope && ['queued', 'creating', 'preparing', 'destroying'].includes(item.status))) throw conflict('This stage already has an environment operation in progress.');
      if (state.environments.filter(item => item.status !== 'destroyed' && !(item.status === 'failed' && (!item.sandboxId || item.cleanedAt))).length >= 8) throw new Error('Delete an environment before creating another (local limit: eight).');
      const id = randomUUID(), release = usage.acquire(context, { environmentId: id, operation: 'create' });
      let queued = false, environment, directoryCreated = false;
      scopesBusy.add(scope);
      try {
        const plan = validateTwinConfig(await planFor(context));
        if (!Object.keys(plan.apps).length) throw new Error('Add an app before creating this environment.');
        environment = { id, scope, pipelineKey: context.key, stageId: context.stageId, repoPath: context.scan.repo.path, sourceBranch: context.scan.repo.branch || null, sourceRevision: context.scan.repo.sha || null, plan, status: 'queued', step: 'Queued', services: [], apps: [], createdAt: now() };
        const directory = join(root, environment.id);
        await mkdir(directory, { mode: 0o700 });
        directoryCreated = true;
        state.environments.unshift(environment);
        try { budget(); } catch (error) { state.environments.shift(); throw error; }
        await persist();
        enqueue(environment.id, async release => {
          let ready;
          try {
            ready = await runtime.prepareEnvironment({ dataDir, environment, repoPath: environment.repoPath, directory, cancelled: () => closed, onUpdate: async update => { Object.assign(environment, update, { updatedAt: now() }); await persist(); } });
          } catch (error) {
            Object.assign(environment, { status: 'failed', step: 'Failed', updatedAt: now(), error: failure(error) });
            if (environment.sandboxId) {
              try { environment.logs = await runtime.environmentLogs({ dataDir, environment }); } catch { /* Preparation can fail before the twin has containers. */ }
              try { await runtime.destroySandbox({ dataDir, environment }); environment.cleanedAt = now(); }
              catch (cleanup) { environment.status = 'cleanup_failed'; environment.cleanupError = failure(cleanup); }
            }
            try { await removeSnapshot(environment); } catch (error) { environment.cleanupError = failure(error); }
          }
          // Report "ready" and release together, so the first action on a ready environment is not refused.
          // Environment state holds a twin's test accounts without passwords; the twin's own state keeps those.
          if (ready) { Object.assign(environment, ready, { accounts: publicAccounts(ready.accounts), origins: (ready.apps || []).map(app => targetOrigin(app.url)).filter(Boolean), updatedAt: now() }); release(); }
          if (environment.status === 'failed') delete environment.plan;
          await persist();
        }, { release, onSettled: async () => {
          if (environment.status === 'ready' && onReady) {
            try { await onReady(context, structuredClone(publicEnvironment(environment))); }
            catch (error) { environment.browserPreparationError = failure(error); await persist(); }
          }
        } });
        queued = true;
        return { environment: publicEnvironment(environment) };
      } catch (error) {
        if (!queued) {
          // Admission failed before runtime allocation. Do not leave a queued
          // record that permanently blocks both creation and Stage removal.
          state.environments = state.environments.filter(item => item !== environment);
          if (directoryCreated) await rm(join(root, id), { recursive: true, force: true }).catch(() => {});
        }
        throw error;
      } finally { scopesBusy.delete(scope); if (!queued) release(); }
    },
    async destroy(context, id, { removalToken = null } = {}) {
      const environment = findEnvironment(context, id, { idle: true });
      const release = usage.acquire(context, { environmentId: id, operation: 'destroy', removalToken });
      let queued = false;
      try {
      if (environment.status === 'destroyed') return { environment: publicEnvironment(environment) };
      environment.status = 'destroying'; environment.step = 'Deleting'; environment.updatedAt = now();
      enqueue(id, async () => {
        try {
          if (environment.sandboxId) await runtime.destroySandbox({ dataDir, environment });
          Object.assign(environment, { status: 'destroyed', step: 'Deleted', services: [], apps: [], destroyedAt: now(), updatedAt: now(), error: null });
          delete environment.accounts;
          await removeSnapshot(environment);
          delete environment.plan;
        } catch (error) { Object.assign(environment, { status: 'cleanup_failed', step: 'Deletion failed', updatedAt: now(), error: failure(error) }); }
        await persist();
      }, { release });
      queued = true;
      await persist();
      return { environment: publicEnvironment(environment) };
      } finally { if (!queued) release(); }
    },
    async logs(context, id) {
      const environment = findEnvironment(context, id);
      if (environment.logs) return { logs: environment.logs };
      return { logs: await runtime.environmentLogs({ dataDir, environment }) };
    },
    async tick() {
      if (closed || ticking) return;
      ticking = true;
      try {
      for (const environment of state.environments) {
        if (closed) break;
        if ((environment.status !== 'ready' && !canRecoverHealth(environment)) || Date.now() - (healthChecks.get(environment.id) || 0) < 30000) continue;
        if (jobs.has(environment.id) || usage.isBusy(environment.id)) { skipHealth(environment.id); continue; }
        let release;
        try { release = usage.acquire({ key: environment.pipelineKey, stageId: environment.stageId }, { environmentId: environment.id, operation: 'health' }); }
        catch (error) { if (error.statusCode === 409) { skipHealth(environment.id); continue; } throw error; }
        healthChecks.set(environment.id, Date.now());
        try {
          let healthError = null;
          try {
            const health = await runtime.environmentHealth({ dataDir, environment });
            if (health.final) healthFailures.set(environment.id, HEALTH_FAILURES - 1);
            if (health.status !== 'ready') throw new Error(health.error || 'The environment is no longer ready.');
            healthFailures.delete(environment.id);
          } catch (error) { healthError = failure(error); }
          healthResults.set(environment.id, { at: Date.now(), ok: !healthError });
          // A late health response cannot clear quarantine or deletion. Only
          // this monitor's own readiness failure is eligible for recovery.
          if ((environment.status !== 'ready' && !canRecoverHealth(environment)) || jobs.has(environment.id)) continue;
          if (healthError) {
            const failures = (healthFailures.get(environment.id) || 0) + 1;
            healthFailures.set(environment.id, failures);
            if (environment.status === 'ready' && failures < HEALTH_FAILURES) continue;
            healthFailures.delete(environment.id);
            Object.assign(environment, { status: 'failed', error: healthError, step: 'Unhealthy', updatedAt: now() });
            await persist();
          } else if (canRecoverHealth(environment)) {
            const previous = { status: environment.status, error: environment.error, step: environment.step, updatedAt: environment.updatedAt };
            Object.assign(environment, { status: 'ready', error: null, step: 'Ready', updatedAt: now() });
            // The shared lease prevents reuse until readiness is durable. A
            // failed save must not release an apparently ready environment.
            try { await persist(); }
            catch (error) { if (environment.status === 'ready') Object.assign(environment, previous); throw error; }
          }
        }
        finally { release(); }
      }
      } finally { ticking = false; }
    },
    close() {
      if (!closing) {
        closed = true;
        closing = (async () => {
          // Do not kill a Docker client and pretend its guest work stopped.
          // Accepted operations retain responsibility through their bounded
          // runtime call, cleanup, and final durable ownership/result record.
          while (pending.size || jobs.size) await Promise.allSettled([...pending, ...jobs.values()]);
          await saving;
          await persist();
        })();
      }
      return closing;
    },
  };
  const reads = new Set(['view', 'logs']);
  const stageWrites = new Set(['savePlan']);
  for (const name of [...reads, ...stageWrites, 'create', 'destroy', 'tick']) {
    const operation = manager[name];
    manager[name] = (...args) => {
      if (closed) return name === 'tick' ? Promise.resolve() : Promise.reject(conflict('The controller is shutting down.'));
      let release;
      try {
        if (stageWrites.has(name)) release = usage.acquire(args[0], { operation: name });
        return track(Promise.resolve(operation(...args)).finally(() => release?.()));
      } catch (error) { release?.(); return Promise.reject(error); }
    };
  }
  return manager;
}
