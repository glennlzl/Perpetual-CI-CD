import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { redact } from '../providers.mjs';

const now = () => new Date().toISOString();
const conflict = message => Object.assign(new Error(message), { statusCode: 409 });
const failure = error => redact(String(error?.message || error)).slice(0, 1500);
const scopeId = ({ key, stageId }) => createHash('sha256').update(`${key}\0${stageId}`).digest('hex');
const hasResources = item => item.status !== 'destroyed' && !(item.status === 'failed' && (!item.sandboxId || item.cleanedAt));
const inProgress = item => ['queued', 'creating', 'preparing', 'destroying'].includes(item.status);
const publicRemoval = ({ context, ...item }) => structuredClone(item);

function pinnedContext(value) {
  if (typeof value?.key !== 'string' || !value.key || value.key.length > 4096
    || typeof value?.stageId !== 'string' || !value.stageId || value.stageId.length > 200) throw new Error('Invalid stage removal scope.');
  return { key: value.key, stageId: value.stageId };
}

function validateState(state) {
  if (state?.version !== 1 || !Array.isArray(state.removals) || state.removals.length > 2000) throw new Error('Invalid stage removal state.');
  const scopes = new Set();
  for (const item of state.removals) {
    const context = pinnedContext(item.context), scope = scopeId(context);
    if (scopes.has(scope) || item.stageId !== context.stageId || typeof item.id !== 'string'
      || !['queued', 'removing', 'completed', 'failed'].includes(item.status)
      || !Array.isArray(item.environmentIds) || item.environmentIds.length > 2000
      || item.environmentIds.some(id => typeof id !== 'string' || !id || id.length > 200)
      || new Set(item.environmentIds).size !== item.environmentIds.length
      || !Array.isArray(item.completedEnvironmentIds)
      || item.completedEnvironmentIds.some(id => !item.environmentIds.includes(id))) throw new Error('Invalid stage removal state.');
    item.context = context;
    scopes.add(scope);
  }
  return state;
}

// This workflow is the owner of accepted deletion intent. Callers confirm a
// Sandbox stage once; losing its browser page does not lose the cleanup work.
export async function createStageRemovalManager({ dataDir, usage, environments, browser, removeStage }) {
  const root = resolve(dataDir, 'stage-removals');
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Stage removal storage must not be a symbolic link.');
  await chmod(root, 0o700);
  const file = join(root, 'state.json');
  let state = { version: 1, removals: [] };
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error('Invalid stage removal state.');
    state = validateState(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }

  const jobs = new Map(), admissions = new Map(), reservations = new Map();
  let closed = false, closePromise, saving = Promise.resolve();
  const recordFor = context => state.removals.find(item => scopeId(item.context) === scopeId(context));
  const stageEnvironments = context => environments.summaries(context.key).filter(item => item.stageId === context.stageId);

  function persist() {
    const pending = saving.then(async () => {
      const serialized = JSON.stringify(state);
      if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) throw new Error('Stage removal history is full.');
      const temp = join(root, `.state-${randomUUID()}.tmp`);
      try {
        await writeFile(temp, serialized, { mode: 0o600 });
        await rename(temp, file);
      } finally { await rm(temp, { force: true }); }
    });
    saving = pending.catch(() => {});
    return pending;
  }

  function reserve(record) {
    const context = record.context, scope = scopeId(context);
    if (browser.isActive(context)) throw conflict('Stop the browser run before deleting this stage.');
    if (stageEnvironments(context).some(inProgress)) throw conflict('Wait for the sandbox operation to finish before deleting this stage.');
    if (!reservations.has(scope)) reservations.set(scope, usage.beginRemoval(context, record.environmentIds));
    return reservations.get(scope);
  }

  function release(record) {
    const scope = scopeId(record.context), token = reservations.get(scope);
    if (token) usage.endRemoval(token);
    reservations.delete(scope);
  }

  async function checkpoint(record) {
    Object.assign(record, { status: 'queued', updatedAt: now() });
    delete record.currentEnvironmentId;
    await persist();
  }

  function launch(record) {
    const scope = scopeId(record.context);
    if (jobs.has(scope) || closed) return;
    const pending = Promise.resolve().then(async () => {
      try {
        if (closed) return checkpoint(record);
        Object.assign(record, { status: 'removing', updatedAt: now() });
        delete record.error;
        await persist();
        for (const id of record.environmentIds) {
          if (closed) return checkpoint(record);
          let environment = stageEnvironments(record.context).find(item => item.id === id);
          if (!environment) throw new Error('Could not confirm sandbox ownership. Restore its environment record before retrying deletion.');
          if (hasResources(environment)) {
            Object.assign(record, { currentEnvironmentId: id, updatedAt: now() });
            await persist();
            if (closed) return checkpoint(record);
            await environments.destroy(record.context, id, { removalToken: reservations.get(scope) });
            await environments.awaitIdle(id);
            environment = stageEnvironments(record.context).find(item => item.id === id);
            if (!environment) throw new Error('Could not confirm sandbox cleanup. Its environment record is missing.');
            if (hasResources(environment)) throw new Error(`Sandbox deletion failed: ${environment.error || environment.cleanupError || 'Cleanup did not finish.'}`);
          }
          if (!record.completedEnvironmentIds.includes(id)) record.completedEnvironmentIds.push(id);
          delete record.currentEnvironmentId;
          record.updatedAt = now();
          await persist();
        }
        if (closed) return checkpoint(record);
        if (stageEnvironments(record.context).some(hasResources)) throw new Error('A sandbox still belongs to this stage. Retry deleting the stage.');
        // The injected transaction uses this saved logical scope, never the
        // currently selected source. It must tolerate a prior successful commit.
        await removeStage(record.context);
        Object.assign(record, { status: 'completed', completedAt: now(), updatedAt: now() });
        await persist();
        release(record);
      } catch (error) {
        Object.assign(record, { status: 'failed', error: failure(error), updatedAt: now() });
        delete record.currentEnvironmentId;
        await persist();
        // Keep the barrier: a failed deletion still owns its resources. Only an
        // explicit retry may proceed; reads and controller restarts do not retry.
      }
    }).finally(() => jobs.delete(scope));
    jobs.set(scope, pending);
    pending.catch(error => process.stderr.write(`Stage removal: ${failure(error)}\n`));
  }

  const manager = {
    view(context) {
      const record = recordFor(pinnedContext(context));
      return { removal: record ? publicRemoval(record) : null };
    },
    summaries(key) { return state.removals.filter(item => item.context.key === key).map(publicRemoval); },
    async start(value) {
      if (closed) throw conflict('The controller is shutting down.');
      const context = pinnedContext(value), scope = scopeId(context);
      if (admissions.has(scope)) { await admissions.get(scope); return manager.view(context); }
      let record = recordFor(context);
      if (record && (jobs.has(scope) || record.status === 'completed')) return manager.view(context);
      const previous = record ? structuredClone(record) : null;
      if (!record) {
        if (state.removals.length >= 2000) throw new Error('Stage removal history is full.');
        record = { id: randomUUID(), context, stageId: context.stageId, status: 'queued',
          environmentIds: [], completedEnvironmentIds: [], createdAt: now(), updatedAt: now() };
      }
      record.environmentIds = [...new Set([...record.environmentIds, ...stageEnvironments(context).filter(hasResources).map(item => item.id)])];
      reserve(record);
      if (!previous) state.removals.push(record);
      Object.assign(record, { status: 'queued', updatedAt: now() });
      delete record.error;
      const accepted = persist();
      admissions.set(scope, accepted);
      try {
        await accepted;
        launch(record);
        return manager.view(context);
      } catch (error) {
        if (previous) Object.assign(record, previous);
        else { state.removals = state.removals.filter(item => item !== record); release(record); }
        throw error;
      } finally { admissions.delete(scope); }
    },
    async awaitIdle(context) {
      const scope = scopeId(pinnedContext(context));
      await admissions.get(scope);
      await jobs.get(scope);
      return manager.view(context);
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        await Promise.allSettled([...admissions.values()]);
        await Promise.allSettled([...jobs.values()]);
        await persist();
        for (const record of state.removals) release(record);
      })();
      return closePromise;
    },
  };

  for (const record of state.removals) {
    if (record.status === 'completed') continue;
    record.environmentIds = [...new Set([...record.environmentIds, ...stageEnvironments(record.context).filter(hasResources).map(item => item.id)])];
    try { reserve(record); }
    catch (error) { Object.assign(record, { status: 'failed', error: failure(error), updatedAt: now() }); }
  }
  await persist();
  for (const record of state.removals) if (['queued', 'removing'].includes(record.status)) launch(record);
  return manager;
}
