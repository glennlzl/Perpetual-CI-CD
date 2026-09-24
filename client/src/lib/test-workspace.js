import { pruneStageDrafts } from './case-drafts.js';
import { previewTargets } from './journey-config.js';

const CONFIG = { targetUrl: '', scope: '', requirements: '', maxSteps: 60 };
const browserView = value => ({ cases: [], runs: [], capabilities: null, preparation: null, ...value, config: { ...CONFIG, ...value?.config } });
const environmentView = value => ({ environments: [], plan: null, ...value });
const endpoint = resource => resource === 'browser' ? '/api/browser' : '/api/environments';
const sourceKey = source => JSON.stringify([source?.path || '', source?.branch || '']);
const active = entry => entry.view.environment.environments.some(item => ['queued', 'creating', 'preparing', 'destroying'].includes(item.status))
  || ['preparing', 'discovering'].includes(entry.view.browser.preparation?.status)
  || entry.view.browser.runs.some(run => ['queued', 'running'].includes(run.status))
  || Object.values(entry.view.browser.specs || {}).some(spec => spec?.generation?.status === 'running');
// Browser progress with an unchanged revision and case states is reused whole;
// scheduler states and frame times stay part of the key.
const progressKey = progress => typeof progress?.revision === 'number' ? JSON.stringify([progress.revision, progress.status, (progress.cases || []).map(item => [item.id, item.status, item.queueReason, item.startedAt, item.completedAt, item.frameUpdatedAt, item.frameCapturedAt, item.actionCount, Array.isArray(item.actions)])]) : null;
// Structural sharing: unchanged records keep their identity across polls.
function share(previous, next, key) {
  if (previous === next || !previous || !next || typeof previous !== 'object' || typeof next !== 'object' || Array.isArray(previous) !== Array.isArray(next)) return next;
  if (key === 'progress' && progressKey(next) && progressKey(next) === progressKey(previous)) return previous;
  const keys = Object.keys(next), result = Array.isArray(next) ? [] : {};
  let changed = keys.length !== Object.keys(previous).length;
  for (const name of keys) { result[name] = share(previous[name], next[name], name); if (result[name] !== previous[name] || !Object.hasOwn(previous, name)) changed = true; }
  return changed ? result : previous;
}
const sameItems = (left, right) => left.length === right.length && left.every((item, index) => item === right[index]);
const sameEntries = (left, right) => sameItems(Object.keys(left), Object.keys(right)) && Object.keys(left).every(key => left[key] === right[key]);

// The workspace owns controller ordering and drafts. Views subscribe to the same
// source-scoped state; observing never starts discovery or test execution.
export function createTestWorkspace({ controller, pollInterval = 3000, document = globalThis.document, pruneDrafts = pruneStageDrafts }) {
  let source = null, identity = '', generation = 0, disposed = false, timer, summaryRevision = 0, sourceError = '', polling = false;
  let stageRemovals = [], previews = [];
  const entries = new Map(), listeners = new Set();
  let snapshot = { browserTests: {}, environments: [], stageRemovals: [], busyStages: [], previews: [], branch: '', error: '' };
  const current = entry => !disposed && entry.generation === generation;
  // Drafts of stages the source's pipeline no longer lists are dropped; an unknown pipeline prunes nothing.
  function prunePipeline(pipeline) {
    if (!source?.path || !Array.isArray(pipeline?.stages) || (pipeline.repoPath && pipeline.repoPath !== source.path)) return;
    pruneDrafts(source.path, pipeline.stages.map(stage => stage?.id));
  }
  function publish(entry) {
    if (disposed) return;
    const next = {
      browserTests: Object.fromEntries([...entries].map(([id, value]) => [id, value.view.browser])),
      environments: [...entries.values()].flatMap(value => value.view.environment.environments),
      stageRemovals,
      busyStages: [...entries].filter(([, value]) => value.view.pending).map(([id]) => id),
      previews,
      branch: source?.branch || '',
      error: sourceError || [...entries.values()].map(value => value.view.error || value.view.pollError).find(Boolean) || '',
    };
    if (sameEntries(next.browserTests, snapshot.browserTests)) next.browserTests = snapshot.browserTests;
    for (const key of ['environments', 'busyStages']) if (sameItems(next[key], snapshot[key])) next[key] = snapshot[key];
    if (!Object.keys(next).every(key => next[key] === snapshot[key])) snapshot = next;
    entry?.listeners.forEach(listener => listener());
    listeners.forEach(listener => listener());
  }
  function update(entry, patch) {
    if (!current(entry)) return;
    for (const key of ['browser', 'environment', 'loading', 'pollErrors']) if (patch[key]) patch[key] = share(entry.view[key], patch[key]);
    if (Object.keys(patch).every(key => entry.view[key] === patch[key])) return;
    entry.view = { ...entry.view, ...patch };
    entry.view.pollError = entry.view.pollErrors.browser || entry.view.pollErrors.environment;
    publish(entry);
  }
  function ensure(id) {
    if (!entries.has(id)) entries.set(id, {
      id, generation, listeners: new Set(), observers: { browser: 0, environment: 0 }, revisions: { browser: 0, environment: 0 }, reading: { browser: 0, environment: 0 }, draftRevisions: {},
      view: { browser: browserView(), environment: environmentView(), drafts: {}, dirty: {}, loading: { browser: true, environment: true }, pending: '', error: '', pollErrors: { browser: '', environment: '' }, pollError: '' },
    });
    return entries.get(id);
  }
  function assertCurrent(entry) {
    if (!current(entry)) throw new Error('The source changed. Reopen this stage.');
  }
  function accept(entry, resource, value) {
    update(entry, { [resource]: resource === 'browser' ? browserView(value) : environmentView(value), loading: { ...entry.view.loading, [resource]: false }, pollErrors: { ...entry.view.pollErrors, [resource]: '' } });
  }
  async function refresh(entry, resource, force = false) {
    if (!current(entry) || (entry.view.pending && !force)) return;
    const revision = ++entry.revisions[resource];
    entry.reading[resource]++;
    try {
      const value = await controller(`${endpoint(resource)}?${new URLSearchParams({ repoPath: source.path, stageId: entry.id })}`);
      if (current(entry) && revision === entry.revisions[resource]) {
        entry.revisions[resource]++;
        accept(entry, resource, value);
      }
    } catch (failure) {
      if (current(entry) && revision === entry.revisions[resource]) update(entry, { pollErrors: { ...entry.view.pollErrors, [resource]: failure.message }, loading: { ...entry.view.loading, [resource]: false } });
    } finally { entry.reading[resource]--; }
  }
  async function refreshSource() {
    if (disposed || !source?.path) return;
    const ownGeneration = generation, request = ++summaryRevision;
    const revisions = new Map([...entries].map(([id, entry]) => [id, { ...entry.revisions }]));
    try {
      const next = await controller('/api/state');
      if (disposed || ownGeneration !== generation || request !== summaryRevision || sourceKey(next.scan?.repo) !== identity) return;
      sourceError = '';
      stageRemovals = share(stageRemovals, next.stageRemovals || []);
      previews = share(previews, previewTargets(next.scan));
      prunePipeline(next.pipeline);
      const ids = new Set([...entries.keys(), ...Object.keys(next.browserTests || {}), ...(next.environments || []).map(item => item.stageId).filter(Boolean)]);
      for (const id of ids) {
        const entry = ensure(id);
        if (entry.view.pending) continue;
        const patch = {};
        if (!entry.reading.browser && entry.revisions.browser === (revisions.get(id)?.browser || 0)) patch.browser = browserView({ ...entry.view.browser, ...(next.browserTests?.[id] || { cases: [], runs: [], preparation: null }) });
        if (!entry.reading.environment && entry.revisions.environment === (revisions.get(id)?.environment || 0)) patch.environment = { ...entry.view.environment, environments: (next.environments || []).filter(item => item.stageId === id) };
        update(entry, patch);
      }
      publish();
      return next;
    } catch (failure) {
      if (!disposed && ownGeneration === generation && request === summaryRevision) { sourceError = failure.message; publish(); }
    }
  }
  // Polling pauses while the page is hidden and resumes as soon as it is visible.
  async function poll() {
    if (disposed || polling || document?.hidden) return;
    polling = true;
    try {
      await Promise.all([
        ...(listeners.size ? [refreshSource()] : []),
        ...[...entries.values()].flatMap(entry => ['browser', 'environment'].filter(resource => entry.observers[resource] || active(entry)).map(resource => refresh(entry, resource))),
      ]);
    } finally { polling = false; }
    schedule();
  }
  function schedule() {
    clearTimeout(timer);
    if (disposed || !pollInterval || document?.hidden) return;
    timer = setTimeout(poll, [...entries.values()].some(active) ? Math.min(pollInterval, 750) : pollInterval);
  }
  const visibility = () => { if (!document.hidden && pollInterval) { clearTimeout(timer); void poll(); } };
  document?.addEventListener?.('visibilitychange', visibility);
  function stage(id) {
    const entry = ensure(id);
    if (entry.handle) return entry.handle;
    async function perform(resource, name, work) {
      assertCurrent(entry);
      if (entry.view.pending) throw new Error('Wait for the current action.');
      entry.revisions.browser++; entry.revisions.environment++;
      update(entry, { pending: name, error: '' });
      const post = async (action, input = {}, options = {}) => {
        assertCurrent(entry);
        const result = await controller(`${endpoint(resource)}/${action}`, { ...input, repoPath: source.path, stageId: id }, options);
        assertCurrent(entry);
        if (result.environment) {
          const environments = entry.view.environment.environments.filter(item => item.id !== result.environment.id);
          accept(entry, 'environment', { ...entry.view.environment, environments: [...environments, result.environment] });
        }
        if (result.run) accept(entry, resource, { ...entry.view[resource], runs: [result.run, ...entry.view[resource].runs.filter(run => run.id !== result.run.id)] });
        if (result.cases) accept(entry, resource, { ...entry.view[resource], cases: result.cases });
        if (result.specs) accept(entry, resource, { ...entry.view[resource], specs: result.specs });
        if (result.config) accept(entry, resource, { ...entry.view[resource], config: result.config });
        if (result.plan) accept(entry, resource, { ...entry.view[resource], plan: result.plan });
        return result;
      };
      const save = async (key, input) => {
        const revision = entry.draftRevisions[key] || 0;
        const result = await post(key, input);
        if (revision === (entry.draftRevisions[key] || 0)) {
          const drafts = { ...entry.view.drafts }, dirty = { ...entry.view.dirty };
          delete drafts[key]; delete dirty[key]; update(entry, { drafts, dirty });
        }
        return result;
      };
      try {
        const result = await work({ post, save });
        assertCurrent(entry);
        await refresh(entry, resource, true);
        return result;
      } catch (failure) {
        if (resource === 'browser' && name === 'cases' && failure.statusCode === 409) await refresh(entry, resource, true);
        if (failure.name !== 'AbortError') update(entry, { error: failure.message });
        throw failure;
      } finally { update(entry, { pending: '' }); }
    }
    entry.handle = {
      getSnapshot: () => entry.view,
      subscribe(listener) { entry.listeners.add(listener); return () => entry.listeners.delete(listener); },
      isCurrent: () => current(entry),
      observe(resources) {
        assertCurrent(entry);
        for (const resource of resources) { entry.observers[resource]++; if (entry.observers[resource] === 1) void refresh(entry, resource); }
        let stopped = false;
        return () => { if (!stopped) for (const resource of resources) entry.observers[resource]--; stopped = true; };
      },
      refresh: resource => refresh(entry, resource),
      edit(key, value) {
        assertCurrent(entry); entry.draftRevisions[key] = (entry.draftRevisions[key] || 0) + 1;
        update(entry, { drafts: { ...entry.view.drafts, [key]: value }, dirty: { ...entry.view.dirty, [key]: true } });
      },
      perform,
      createEnvironment() {
        return perform('environment', 'create', tx => tx.post('create'));
      },
      saveBrowserCase(item, original) {
        return perform('browser', 'cases', tx => {
          const cases = entry.view.browser.cases;
          const baseCases = original ? cases.map(value => value.id === original.id ? original : value) : cases;
          if (original && !cases.some(value => value.id === original.id)) baseCases.push(original);
          return tx.post('cases', { cases: cases.some(value => value.id === item.id) ? cases.map(value => value.id === item.id ? item : value) : [...cases, item], baseCases });
        });
      },
    };
    return entry.handle;
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    stage,
    refreshSource,
    activate(nextSource, seed = {}) {
      if (disposed) throw new Error('The test workspace is closed.');
      const nextIdentity = sourceKey(nextSource);
      generation++; identity = nextIdentity; source = { ...nextSource }; sourceError = '';
      stageRemovals = seed.stageRemovals || [];
      previews = share(previews, previewTargets(seed.scan));
      prunePipeline(seed.pipeline);
      const previous = [...entries.values()]; entries.clear();
      for (const [id, value] of Object.entries(seed.browserTests || {})) ensure(id).view.browser = browserView(value);
      for (const item of seed.environments || []) if (item.stageId) ensure(item.stageId).view.environment.environments.push(item);
      publish(); previous.forEach(entry => entry.listeners.forEach(listener => listener())); schedule();
      if (!Object.hasOwn(seed, 'browserTests')) void refreshSource();
    },
    dispose() { disposed = true; generation++; clearTimeout(timer); document?.removeEventListener?.('visibilitychange', visibility); listeners.clear(); entries.forEach(entry => entry.listeners.clear()); },
  };
}
