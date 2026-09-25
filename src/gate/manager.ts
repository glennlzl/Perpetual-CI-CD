import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { redact } from '../providers.ts';
import type { BranchHead, BranchHeadInput, CommitStatusPost } from './github.ts';
import { ACTIVE, SHA, commitStatus, nextGate, productionReady, sameStatus, short, stageGate, verdict, type CommitState, type CommitStatus, type Gate, type GateRef, type GateStatus, type RunRollup } from './rules.ts';

export interface GateStage { id: string; name: string; kind: string }
/** The active pipeline; repository is set only for a managed GitHub source, the only one the watcher may move. */
export interface GateSource { key: string; branch: string | null; sha: string | null; repository?: string | null; stages: readonly GateStage[] }
export interface GateConnection { login: string; repository: string }
export interface GateGitHub {
  connection(): Promise<GateConnection | null>;
  head(input: BranchHeadInput): Promise<BranchHead>;
  post(status: CommitStatusPost): Promise<void>;
}
/** A gate's work: prepare(gate) -> context (409: not now), journeys(context) -> count, rebuild(context) -> twin, run(context, twin) -> finished run. */
export interface GateSteps<Context, Twin, Run = RunRollup | null | undefined> {
  prepare(gate: GateRef): Promise<Context>;
  journeys(context: Context): number | Promise<number>;
  rebuild(context: Context): Promise<Twin>;
  run(context: Context, twin: Twin): Promise<Run>;
}
export interface GateManagerOptions<Context, Twin> {
  dataDir: string; source: () => GateSource | null; github: GateGitHub; steps: GateSteps<Context, Twin>;
  now?: () => string; pollInterval?: number; retryInterval?: number;
}
/** A gate as the pipeline shows it. */
export type PublicGate = Pick<Gate, 'id' | 'stageId' | 'sha' | 'status' | 'reason' | 'releasedBy' | 'releasedAt' | 'statusError' | 'detectedAt' | 'updatedAt'>;
export interface GateView { stages: Record<string, PublicGate>; production: { sha: string; status: 'ready' } | null; watchError?: string }
/** The last branch head the watcher saw for a pipeline, and the account that read it; checkedAt is only a record. */
interface Head { branch: string | null; login: string; sha: string; etag: string | null; checkedAt?: string }
interface GateState { version: 1; gates: Gate[]; heads: Partial<Record<string, Head>> }

// Every gate status and commit state, so a stored gate is checked against the whole set.
const GATE_STATUSES: Record<GateStatus, true> = { queued: true, rebuilding: true, running: true, passed: true, failed: true, 'needs-release': true, released: true, superseded: true };
const COMMIT_STATES: Record<CommitState, true> = { pending: true, success: true, failure: true, error: true };
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string';
const optionalText = (value: unknown) => value === undefined || isText(value);
const isPosted = (value: unknown): value is CommitStatus => isRecord(value) && isText(value.state) && Object.hasOwn(COMMIT_STATES, value.state) && isText(value.context) && isText(value.description);
/** A stored gate with every field its commit status and schedule read. */
const validGate = (value: unknown): value is Gate => isRecord(value)
  && (['id', 'key', 'stageId', 'sha', 'context', 'createdAt', 'detectedAt', 'updatedAt'] as const).every(field => isText(value[field]))
  && (value.branch === null || isText(value.branch)) && isText(value.status) && Object.hasOwn(GATE_STATUSES, value.status)
  && (['reason', 'startedAt', 'completedAt', 'runId', 'environmentId', 'releasedBy', 'releasedAt', 'statusError'] as const).every(field => optionalText(value[field]))
  && (value.posted === undefined || isPosted(value.posted));
const validHead = (value: unknown): value is Head => isRecord(value) && (value.branch === null || isText(value.branch))
  && isText(value.login) && isText(value.sha) && (value.etag === null || isText(value.etag)) && optionalText(value.checkedAt);
const validHeads = (value: unknown): value is GateState['heads'] => isRecord(value) && Object.values(value).every(validHead);
const conflict = (message: string) => Object.assign(new Error(message), { statusCode: 409 });
const text = (error: unknown) => redact(String((error as { message?: unknown } | null | undefined)?.message || error)).slice(0, 500);
const LIMIT = 300;
// Only recent gates are reported again after a failed report.
const REPORTED = 50;
const publicGate = ({ id, stageId, sha, status, reason, releasedBy, releasedAt, statusError, detectedAt, updatedAt }: Gate): PublicGate =>
  ({ id, stageId, sha, status, ...(reason ? { reason } : {}), ...(releasedBy ? { releasedBy, releasedAt } : {}), ...(statusError ? { statusError } : {}), detectedAt, updatedAt });

/**
 * Journey gates per (stage, commit), persisted under <dataDir>/gates. One gate runs at a time.
 * source() -> { key, branch, sha, repository|null, stages: [{ id, name, kind }] } | null: the active pipeline;
 *   repository is set only for a managed GitHub source, the only one the watcher may move.
 * github: connection() -> { login, repository } | null, head({ repository, branch, etag }), post(status).
 * steps: prepare(gate) -> context (409: not now), journeys(context) -> count, rebuild(context) -> twin,
 *   run(context, twin) -> finished run.
 */
export async function createGateManager<Context, Twin extends { id?: string | null } | null | undefined>({ dataDir, source, github, steps, now = () => new Date().toISOString(), pollInterval = 60_000, retryInterval = 10_000 }: GateManagerOptions<Context, Twin>) {
  const configured = resolve(dataDir, 'gates');
  await mkdir(configured, { recursive: true, mode: 0o700 });
  if ((await lstat(configured)).isSymbolicLink()) throw new Error('Gate storage must not be a symbolic link.');
  const root = await realpath(configured);
  await chmod(root, 0o700);
  const file = join(root, 'state.json');
  let state: GateState = { version: 1, gates: [], heads: {} };
  try {
    const saved: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!isRecord(saved) || saved.version !== 1 || !Array.isArray(saved.gates) || !saved.gates.every(validGate) || !validHeads(saved.heads)) throw new Error('Unsupported gate state.');
    state = { version: 1, gates: saved.gates, heads: saved.heads };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // A twin or run the controller stopped during has no verdict; a person decides.
  for (const gate of state.gates) if (ACTIVE.includes(gate.status)) Object.assign(gate, { status: 'needs-release', reason: 'Interrupted by a controller restart.', completedAt: now(), updatedAt: now() } satisfies Partial<Gate>);
  let saving = Promise.resolve(), closed = false, draining: Promise<void> | null = null, watching: Promise<void> | null = null, syncing: Promise<void> | null = null, syncAgain = false;
  let timer: NodeJS.Timeout | undefined, retry: NodeJS.Timeout | undefined, watchError: string | null = null;
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
  const sandboxes = (current: GateSource) => current.stages.filter(stage => stage.kind === 'sandbox');
  const scoped = (current: GateSource) => state.gates.filter(gate => gate.key === current.key && gate.branch === current.branch);

  function enqueue(current: GateSource, stage: GateStage, sha: string, detectedAt: string) {
    const time = now();
    let gate = state.gates.find(item => item.key === current.key && item.branch === current.branch && item.stageId === stage.id && item.sha === sha);
    if (gate && ['queued', ...ACTIVE].includes(gate.status)) return gate;
    // Only the newest pending commit of a stage runs; an older one arriving later is recorded as superseded.
    const newer = scoped(current).some(item => item.stageId === stage.id && item.sha !== sha && item.status !== 'superseded' && item.detectedAt > detectedAt);
    if (!gate) { gate = { id: randomUUID(), key: current.key, branch: current.branch, stageId: stage.id, sha, context: `perpetual/${stage.name}`, createdAt: time, status: 'queued', detectedAt, updatedAt: time }; state.gates.unshift(gate); }
    for (const field of ['reason', 'startedAt', 'completedAt', 'runId', 'environmentId', 'releasedBy', 'releasedAt'] as const) delete gate[field];
    Object.assign(gate, { status: newer ? 'superseded' : 'queued', detectedAt, updatedAt: time } satisfies Partial<Gate>, newer ? { reason: 'A newer commit reached this stage.' } : {});
    if (!newer) for (const other of scoped(current)) if (other !== gate && other.stageId === stage.id && other.status === 'queued') Object.assign(other, { status: 'superseded', reason: `Superseded by ${short(sha)}.`, updatedAt: time } satisfies Partial<Gate>);
    state.gates = state.gates.filter((item, index) => index < LIMIT || ['queued', ...ACTIVE].includes(item.status));
    return gate;
  }
  // A passed or released commit moves to the next Sandbox stage; Production is only shown Ready.
  function promote(gate: Gate) {
    const current = active();
    if (!current || current.key !== gate.key || current.branch !== gate.branch) return;
    const following = current.stages[current.stages.findIndex(stage => stage.id === gate.stageId) + 1];
    if (following?.kind === 'sandbox') enqueue(current, following, gate.sha, gate.detectedAt);
  }
  async function settle(gate: Gate, status: GateStatus, reason?: string) {
    const time = now();
    Object.assign(gate, { status, updatedAt: time, completedAt: time } satisfies Partial<Gate>);
    if (reason) gate.reason = reason; else delete gate.reason;
    if (status === 'passed') promote(gate);
    await persist();
    void sync();
  }
  async function transition(gate: Gate, status: GateStatus, fields: Partial<Gate> = {}) {
    Object.assign(gate, fields, { status, updatedAt: now() });
    await persist();
    void sync();
  }
  // Returns false when the stage cannot start now; the gate stays queued for a later attempt.
  async function execute(gate: Gate) {
    let context: Context;
    try { context = await steps.prepare({ key: gate.key, branch: gate.branch, stageId: gate.stageId, sha: gate.sha }); }
    catch (error) {
      if (closed || (error as { statusCode?: unknown }).statusCode === 409) return false;
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
      const waiting = new Set<Gate>();
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
        let connection: GateConnection | null = null;
        try { connection = await github.connection(); } catch { connection = null; }
        for (const gate of due) {
          const status = commitStatus(gate);
          // A gate queued again while the connection was read reports nothing.
          if (!status) continue;
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
  function view(): GateView {
    const current = active();
    if (!current) return { stages: {}, production: null };
    const gates = scoped(current), ids = sandboxes(current).map(stage => stage.id);
    const stages = Object.fromEntries(ids.map(id => [id, stageGate(gates.filter(gate => gate.stageId === id))] as const).filter((entry): entry is readonly [string, Gate] => Boolean(entry[1])).map(([id, gate]) => [id, publicGate(gate)]));
    return { stages, production: productionReady(gates, ids), ...(watchError ? { watchError } : {}) };
  }
  const guard = () => { if (closed) throw conflict('The controller is shutting down.'); };
  return {
    view,
    watch,
    /** Run now: the stage's gate at the branch head (or the scanned commit), re-running a finished one. */
    async run({ stageId }: { stageId: unknown }) {
      guard();
      let current = active();
      if (!current) throw new Error('Scan a repository first.');
      if (!sandboxes(current).some(stage => stage.id === stageId)) throw new Error('Choose a Sandbox stage.');
      await watch();
      current = active();
      const stage = current && sandboxes(current).find(item => item.id === stageId);
      if (!current || !stage) throw conflict('The active source changed. Reload the pipeline.');
      const head = state.heads[current.key];
      const sha = current.repository && head?.branch === current.branch ? head.sha : current.sha;
      if (typeof sha !== 'string' || !SHA.test(sha)) throw new Error('Scan a repository with a commit first.');
      enqueue(current, stage, sha.toLowerCase(), now());
      await persist();
      kick();
      return view();
    },
    /** Release: a person accepts a gate that needs release; a failed gate is never released. */
    async release({ stageId, sha, login }: { stageId: unknown; sha: unknown; login?: unknown }) {
      guard();
      const current = active();
      if (!current) throw new Error('Scan a repository first.');
      if (typeof login !== 'string' || !login) throw new Error('Connect GitHub to release.');
      const gate = scoped(current).find(item => item.stageId === stageId && item.sha === sha);
      if (!gate) throw Object.assign(new Error('Gate not found.'), { statusCode: 404 });
      if (gate.status !== 'needs-release') throw conflict(gate.status === 'failed' ? 'A failed gate cannot be released.' : 'This gate does not need release.');
      Object.assign(gate, { status: 'released', releasedBy: login, releasedAt: now(), updatedAt: now() } satisfies Partial<Gate>);
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
export type GateManager = Awaited<ReturnType<typeof createGateManager>>;
