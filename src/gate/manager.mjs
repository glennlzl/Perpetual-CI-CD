import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { redact } from '../providers.mjs';
import { ACTIVE, SHA, commitStatus, nextGate, productionReady, sameStatus, short, stageGate, verdict } from './rules.mjs';

const conflict = message => Object.assign(new Error(message), { statusCode: 409 });
const text = error => redact(String(error?.message || error)).slice(0, 500);
const LIMIT = 300;
// Only recent gates are reported again after a failed report.
const REPORTED = 50;
const publicGate = ({ id, stageId, sha, status, reason, releasedBy, releasedAt, statusError, detectedAt, updatedAt }) =>
  ({ id, stageId, sha, status, ...(reason ? { reason } : {}), ...(releasedBy ? { releasedBy, releasedAt } : {}), ...(statusError ? { statusError } : {}), detectedAt, updatedAt });

/**
 * Journey gates per (stage, commit), persisted under <dataDir>/gates. One gate runs at a time.
 * source() -> { key, branch, sha, repository|null, stages: [{ id, name, kind }] } | null: the active pipeline;
 *   repository is set only for a managed GitHub source, the only one the watcher may move.
 * github: connection() -> { login, repository } | null, head({ repository, branch, etag }), post(status).
 * steps: prepare(gate) -> context (409: not now), journeys(context) -> count, rebuild(context) -> twin,
 *   run(context, twin) -> finished run.
 */
export async function createGateManager({ dataDir, source, github, steps, now = () => new Date().toISOString(), pollInterval = 60_000, retryInterval = 10_000 }) {
  const configured = resolve(dataDir, 'gates');
  await mkdir(configured, { recursive: true, mode: 0o700 });
  if ((await lstat(configured)).isSymbolicLink()) throw new Error('Gate storage must not be a symbolic link.');
  const root = await realpath(configured);
  await chmod(root, 0o700);
  const file = join(root, 'state.json');
  let state = { version: 1, gates: [], heads: {} };
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    if (saved.version !== 1 || !Array.isArray(saved.gates) || !saved.heads || typeof saved.heads !== 'object') throw new Error('Unsupported gate state.');
    state = saved;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // A twin or run the controller stopped during has no verdict; a person decides.
  for (const gate of state.gates) if (ACTIVE.includes(gate.status)) Object.assign(gate, { status: 'needs-release', reason: 'Interrupted by a controller restart.', completedAt: now(), updatedAt: now() });
  let saving = Promise.resolve(), closed = false, draining = null, watching = null, syncing = null, syncAgain = false, timer = null, retry = null, watchError = null;
  function persist() {
    const operation = saving.then(async () => {
      const temporary = join(root, `.state-${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await rename(temporary, file);
    });
    saving = operation.catch(() => {});
    return operation;
  }
  await persist();

  const active = () => { const current = source(); return current?.key ? current : null; };
  const sandboxes = current => current.stages.filter(stage => stage.kind === 'sandbox');
  const scoped = current => state.gates.filter(gate => gate.key === current.key && gate.branch === current.branch);

  function enqueue(current, stage, sha, detectedAt) {
    const time = now();
    let gate = state.gates.find(item => item.key === current.key && item.branch === current.branch && item.stageId === stage.id && item.sha === sha);
    if (gate && ['queued', ...ACTIVE].includes(gate.status)) return gate;
    // Only the newest pending commit of a stage runs; an older one arriving later is recorded as superseded.
    const newer = scoped(current).some(item => item.stageId === stage.id && item.sha !== sha && item.status !== 'superseded' && item.detectedAt > detectedAt);
    if (!gate) { gate = { id: randomUUID(), key: current.key, branch: current.branch, stageId: stage.id, sha, context: `perpetual/${stage.name}`, createdAt: time }; state.gates.unshift(gate); }
    for (const field of ['reason', 'startedAt', 'completedAt', 'runId', 'environmentId', 'releasedBy', 'releasedAt']) delete gate[field];
    Object.assign(gate, { status: newer ? 'superseded' : 'queued', detectedAt, updatedAt: time }, newer ? { reason: 'A newer commit reached this stage.' } : {});
    if (!newer) for (const other of scoped(current)) if (other !== gate && other.stageId === stage.id && other.status === 'queued') Object.assign(other, { status: 'superseded', reason: `Superseded by ${short(sha)}.`, updatedAt: time });
    state.gates = state.gates.filter((item, index) => index < LIMIT || ['queued', ...ACTIVE].includes(item.status));
    return gate;
  }
  // A passed or released commit moves to the next Sandbox stage; Production is only shown Ready.
  function promote(gate) {
    const current = active();
    if (!current || current.key !== gate.key || current.branch !== gate.branch) return;
    const following = current.stages[current.stages.findIndex(stage => stage.id === gate.stageId) + 1];
    if (following?.kind === 'sandbox') enqueue(current, following, gate.sha, gate.detectedAt);
  }
  async function settle(gate, status, reason) {
    const time = now();
    Object.assign(gate, { status, updatedAt: time, completedAt: time });
    if (reason) gate.reason = reason; else delete gate.reason;
    if (status === 'passed') promote(gate);
    await persist();
    void sync();
  }
  async function transition(gate, status, fields = {}) {
    Object.assign(gate, fields, { status, updatedAt: now() });
    await persist();
    void sync();
  }
  // Returns false when the stage cannot start now; the gate stays queued for a later attempt.
  async function execute(gate) {
    let context;
    try { context = await steps.prepare({ key: gate.key, branch: gate.branch, stageId: gate.stageId, sha: gate.sha }); }
    catch (error) {
      if (closed || error.statusCode === 409) return false;
      await settle(gate, 'needs-release', text(error));
      return true;
    }
    try {
      if (!(await steps.journeys(context))) { await settle(gate, 'needs-release', 'No reviewed journeys.'); return true; }
      await transition(gate, 'rebuilding', { startedAt: now() });
      const twin = await steps.rebuild(context);
      if (closed) return false;
      await transition(gate, 'running', twin?.id ? { environmentId: twin.id } : {});
      const run = await steps.run(context, twin);
      if (closed) return false;
      if (run?.id) gate.runId = run.id;
      const result = verdict(run);
      await settle(gate, result.status, result.reason);
    } catch (error) {
      // Interrupted work is recorded at the next start, never as a verdict.
      if (closed) return false;
      await settle(gate, 'needs-release', text(error));
    }
    return true;
  }
  function kick() {
    if (closed || draining) return draining;
    // A busy stage is skipped for this pass and retried later, so it never holds back another stage.
    // The task settles after its assignment, so a pass with nothing to run leaves no stale task.
    draining = Promise.resolve().then(async () => {
      const waiting = new Set();
      for (;;) {
        const current = active();
        const gate = current && nextGate(scoped(current).filter(item => !waiting.has(item)), sandboxes(current).map(stage => stage.id));
        if (!gate || closed) break;
        if (!(await execute(gate))) waiting.add(gate);
      }
      if (waiting.size && !closed) { clearTimeout(retry); retry = setTimeout(kick, retryInterval); retry.unref?.(); }
    }).catch(error => { process.stderr.write(`Journey gate: ${text(error)}\n`); }).finally(() => { draining = null; });
    return draining;
  }
  // Commit statuses follow gate states; a failed report is recorded and retried, never blocking the gate.
  function sync() {
    if (syncing) { syncAgain = true; return syncing; }
    syncing = Promise.resolve().then(async () => {
      do {
        syncAgain = false;
        const current = active();
        if (!current || closed) break;
        const due = state.gates.slice(0, REPORTED).filter(gate => gate.key === current.key && commitStatus(gate) && !sameStatus(commitStatus(gate), gate.posted));
        if (!due.length) continue;
        let connection = null;
        try { connection = await github.connection(); } catch { connection = null; }
        for (const gate of due) {
          const status = commitStatus(gate);
          if (!connection) { gate.statusError = 'Connect GitHub to report commit status.'; continue; }
          try { await github.post({ repository: connection.repository, sha: gate.sha, ...status }); gate.posted = status; delete gate.statusError; }
          catch (error) { gate.statusError = text(error); }
        }
        await persist();
      } while (syncAgain && !closed);
    }).catch(error => { process.stderr.write(`Journey gate status: ${text(error)}\n`); }).finally(() => { syncing = null; });
    return syncing;
  }
  // Polls the target branch of a managed GitHub source. The first head seen for a branch is a
  // baseline, not a push; every later change queues the first Sandbox stage.
  function watch() {
    if (closed) return Promise.resolve();
    watching ??= Promise.resolve().then(async () => {
      const current = active();
      if (!current?.repository) return;
      const connection = await github.connection();
      if (!connection || closed) return;
      const previous = state.heads[current.key];
      const known = previous?.branch === current.branch && previous.login === connection.login;
      const head = await github.head({ repository: current.repository, branch: current.branch, etag: known ? previous.etag : null });
      watchError = null;
      if (closed || head.status === 304) return;
      state.heads[current.key] = { branch: current.branch, login: connection.login, sha: head.sha, etag: head.etag, checkedAt: now() };
      const first = sandboxes(current)[0];
      if (first && previous?.branch === current.branch && previous.sha !== head.sha) enqueue(current, first, head.sha, now());
      await persist();
      kick();
    }).catch(error => { watchError = text(error); }).finally(() => { watching = null; });
    return watching;
  }
  function view() {
    const current = active();
    if (!current) return { stages: {}, production: null };
    const gates = scoped(current), ids = sandboxes(current).map(stage => stage.id);
    const stages = Object.fromEntries(ids.map(id => [id, stageGate(gates.filter(gate => gate.stageId === id))]).filter(([, gate]) => gate).map(([id, gate]) => [id, publicGate(gate)]));
    return { stages, production: productionReady(gates, ids), ...(watchError ? { watchError } : {}) };
  }
  const guard = () => { if (closed) throw conflict('The controller is shutting down.'); };
  return {
    view,
    watch,
    /** Run now: the stage's gate at the branch head (or the scanned commit), re-running a finished one. */
    async run({ stageId }) {
      guard();
      let current = active();
      if (!current) throw new Error('Scan a repository first.');
      if (!sandboxes(current).some(stage => stage.id === stageId)) throw new Error('Choose a Sandbox stage.');
      await watch();
      current = active();
      const stage = current && sandboxes(current).find(item => item.id === stageId);
      if (!stage) throw conflict('The active source changed. Reload the pipeline.');
      const head = state.heads[current.key];
      const sha = current.repository && head?.branch === current.branch ? head.sha : current.sha;
      if (typeof sha !== 'string' || !SHA.test(sha)) throw new Error('Scan a repository with a commit first.');
      enqueue(current, stage, sha.toLowerCase(), now());
      await persist();
      kick();
      return view();
    },
    /** Release: a person accepts a gate that needs release; a failed gate is never released. */
    async release({ stageId, sha, login }) {
      guard();
      const current = active();
      if (!current) throw new Error('Scan a repository first.');
      if (typeof login !== 'string' || !login) throw new Error('Connect GitHub to release.');
      const gate = scoped(current).find(item => item.stageId === stageId && item.sha === sha);
      if (!gate) throw Object.assign(new Error('Gate not found.'), { statusCode: 404 });
      if (gate.status !== 'needs-release') throw conflict(gate.status === 'failed' ? 'A failed gate cannot be released.' : 'This gate does not need release.');
      Object.assign(gate, { status: 'released', releasedBy: login, releasedAt: now(), updatedAt: now() });
      promote(gate);
      await persist();
      void sync();
      kick();
      return view();
    },
    start() {
      if (closed || timer) return;
      timer = setInterval(() => { void watch().then(sync); }, pollInterval);
      timer.unref?.();
      void sync();
      kick();
    },
    /** Resolves once scheduled gates, reports and watches have settled. */
    async idle() { while (draining || syncing || watching) await Promise.allSettled([draining, syncing, watching]); await saving; },
    async close() {
      closed = true;
      clearInterval(timer); clearTimeout(retry);
      await Promise.allSettled([draining, syncing, watching]);
      await saving;
    },
  };
}
