import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, chmod, lstat, rm, rmdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { detectEnvironmentConfig } from './plans.ts';
import { prepareEnvironment, environmentHealth, environmentLogs, destroySandbox } from './runtime.ts';
import { redact } from '../providers.ts';
import { createEnvironmentUsage } from './usage.ts';
import { validateTwinConfig } from '../twin/index.ts';
import { HOST } from '../twin/compose.ts';
import type { DetectionScan } from './plans.ts';
import type { EnvironmentUsage, StageRef } from './usage.ts';
import type { TwinConfig } from '../twin/config.ts';
import type { DetectedConfig } from '../twin/detect.ts';
import type { Fidelity } from '../twin/registry.ts';

export type EnvironmentStatus = 'queued' | 'creating' | 'preparing' | 'ready' | 'failed' | 'cleanup_failed' | 'destroying' | 'destroyed';
/** A twin service as its environment shows it. */
export interface EnvironmentService { id: string; title: string; fidelity: Fidelity; status: 'ready' | 'blocked'; missing: string[] }
export interface EnvironmentApp { id: string; url: string }
/** A twin test account without its password, which only the twin's private state keeps. */
export interface EnvironmentAccount { id: string; label: string; username: string }
export interface StepTiming { step: string; ms: number }
/** A stage's twin plan: detected from the repository, or the user's saved config. */
export type EnvironmentPlan = DetectedConfig | TwinConfig;
/** One environment as the controller keeps it; `plan` is the validated config it was created from. */
export interface EnvironmentRecord {
  id: string; scope: string; pipelineKey: string; stageId: string; repoPath: string; sourceBranch: string | null; sourceRevision: string | null;
  plan?: TwinConfig; status: EnvironmentStatus; step: string; services: EnvironmentService[]; apps: EnvironmentApp[]; createdAt: string; updatedAt?: string;
  error?: string | null; sandboxId?: string; snapshot?: { hash: string; files: number; bytes: number }; timings?: StepTiming[]; readyAt?: string;
  accounts?: EnvironmentAccount[]; origins?: string[]; logs?: string; cleanedAt?: string; cleanupError?: string; destroyedAt?: string; browserPreparationError?: string;
}
export type PublicEnvironment = Omit<EnvironmentRecord, 'scope' | 'plan' | 'logs' | 'origins'>;
/** The monitor's last check, kept in memory only: when it ran, whether it passed and its consecutive failures, or when a due check was skipped as in use. */
export type HealthBeat = { checkedAt?: string; ok?: boolean; consecutiveFailures?: number; skippedInUseAt?: string };
/** An environment as stage views list it. */
export type EnvironmentSummary = PublicEnvironment & { health?: HealthBeat };
/** The stage an environment operation is for, with the scan its plan is detected from. */
export type EnvironmentContext = StageRef & { scan: DetectionScan & { repo: { branch?: string | null; sha?: string | null }; scannedAt?: string }; controllerOrigin?: string };
type RuntimeCall = { dataDir: string; environment: EnvironmentRecord };
/** What the manager calls on its runtime (./runtime.ts): a ready result is merged into its environment as it is. */
export interface ManagedRuntime {
  prepareEnvironment(options: RuntimeCall & { repoPath: string; directory: string; cancelled: () => boolean; onUpdate: (update: Partial<EnvironmentRecord>) => Promise<void> }): Promise<Partial<EnvironmentRecord>>;
  environmentHealth(options: RuntimeCall): Promise<{ status: string; error?: string; final?: boolean }>;
  environmentLogs(options: RuntimeCall): Promise<string>;
  destroySandbox(options: RuntimeCall): Promise<unknown>;
}
/** Saved state may hold keys of removed features, and a Cua guest's services had URLs. */
type SavedEnvironment = Omit<EnvironmentRecord, 'services'> & {
  services: (EnvironmentService & { url?: string })[]; twinsToken?: unknown; activeOperation?: unknown; desktopUrl?: unknown; serviceOrigins?: string[];
};

const now = () => new Date().toISOString();
const scopeId = ({ key, stageId }: StageRef) => createHash('sha256').update(`${key}\0${stageId}`).digest('hex');
const FAILURE_TEXT = 1500, FAILURE_HEAD = 300, OMITTED = '\n…\n';
// A long failure keeps its start, which names the step, and its end, where a command reports its error.
const failure = (error: unknown) => {
  const text = redact(String((error as Error).message || error));
  return text.length <= FAILURE_TEXT ? text : `${text.slice(0, FAILURE_HEAD)}${OMITTED}${text.slice(-(FAILURE_TEXT - FAILURE_HEAD - OMITTED.length))}`;
};
const publicEnvironment = ({ scope, plan, logs, origins, ...item }: EnvironmentRecord): PublicEnvironment => item;
// A twin's test accounts as environments keep and show them; passwords stay in the twin's private state.
const publicAccounts = (accounts: EnvironmentAccount[] | undefined) => (Array.isArray(accounts) ? accounts : []).map(({ id, label, username }) => ({ id, label, username }));
const conflict = (message: string) => Object.assign(new Error(message), { statusCode: 409 });
const UUID = /^[a-f0-9-]{36}$/;
const HEALTH_FAILURES = 3;
const defaultRuntime: ManagedRuntime = { prepareEnvironment, environmentHealth, environmentLogs, destroySandbox };
const canRecoverHealth = (environment: EnvironmentRecord) => environment.status === 'failed' && environment.step === 'Unhealthy'
  && environment.sandboxId && environment.plan && !environment.cleanedAt;
// Perpetual's browser and the twin's containers reach the host under these names.
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]', HOST];
function targetOrigin(value: unknown) {
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (LOOPBACK.includes(url.hostname)) url.hostname = '127.0.0.1';
    return url.origin;
  } catch { return null; }
}
// A plan saved before twins listed services with install and start commands; a fresh detection replaces it.
const legacyPlan = (plan: { services?: unknown } | null | undefined) => Array.isArray(plan?.services);
// Saved state may hold keys of removed features: top-level cases, analyses, runs and
// schedules, and environment twinsToken, activeOperation and desktopUrl. Loading drops them.
// A twin's sandbox id is its environment's id. Any other sandbox is a Cua guest from
// before twins, which only awaits deletion.
function loadedEnvironment({ twinsToken, activeOperation, desktopUrl, serviceOrigins, ...environment }: SavedEnvironment): EnvironmentRecord {
  environment.origins ??= serviceOrigins ?? (environment.services || []).map(service => targetOrigin(service.url)).filter(origin => origin !== null);
  if (legacyPlan(environment.plan)) delete environment.plan;
  if (!environment.sandboxId || environment.sandboxId === environment.id) return environment;
  environment.services = [];
  if (['ready', 'failed'].includes(environment.status) && !environment.cleanedAt) Object.assign(environment, { status: 'failed', step: 'Retired', error: 'Delete this environment to remove its Cua guest.' });
  return environment;
}

/** Context is the caller's stage context, which the manager hands back to onReady as it was given. */
export async function createEnvironmentManager<Context extends EnvironmentContext = EnvironmentContext>({ dataDir, onReady, usage = createEnvironmentUsage(), runtime = defaultRuntime, interruptedEnvironmentIds = [] }: {
  dataDir: string; onReady?: (context: Context, environment: PublicEnvironment) => unknown; usage?: EnvironmentUsage;
  runtime?: ManagedRuntime; interruptedEnvironmentIds?: string[];
}) {
  const configuredRoot = resolve(dataDir, 'environments');
  await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
  if ((await lstat(configuredRoot)).isSymbolicLink()) throw new Error('Environment storage must not be a symbolic link.');
  // Resolve system aliases such as /tmp and /var before deriving owned snapshot
  // destinations; snapshotSource still rejects an explicitly linked destination.
  const root = await realpath(configuredRoot);
  await chmod(root, 0o700);
  const file = join(root, 'state.json');
  // detected: the scan each detected plan came from. A plan detected from an earlier scan is detected again, so a
  // repository change or a better detector reaches it; a saved plan is the user's and is never replaced.
  let state: { version: 1; plans: Record<string, EnvironmentPlan>; detected: Record<string, string>; environments: EnvironmentRecord[] } = { version: 1, plans: {}, detected: {}, environments: [] };
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw new Error('Invalid environment state.');
    // The controller's own state file; the checks below decide whether it is one it can load.
    const saved: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!saved || typeof saved !== 'object' || !('version' in saved) || saved.version !== 1 || !('environments' in saved) || !Array.isArray(saved.environments)
      || !('plans' in saved) || !saved.plans || typeof saved.plans !== 'object') throw new Error('Unsupported environment state.');
    const plans = Object.fromEntries(Object.entries(saved.plans as Record<string, EnvironmentPlan>).filter(([, plan]) => !legacyPlan(plan)));
    const detected = 'detected' in saved && saved.detected && typeof saved.detected === 'object' && !Array.isArray(saved.detected) ? Object.fromEntries(Object.entries(saved.detected).filter(([scope, key]) => Object.hasOwn(plans, scope) && typeof key === 'string')) as Record<string, string> : {};
    // Records the controller saved; loadedEnvironment drops the fields of removed features.
    state = { version: 1, plans, detected, environments: (saved.environments as SavedEnvironment[]).map(loadedEnvironment) };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let saving: Promise<unknown> = Promise.resolve(), closed = false, closing: Promise<void> | undefined, ticking = false;
  const jobs = new Map<string, Promise<void>>(), pending = new Set<Promise<unknown>>(), scopesBusy = new Set<string>(), healthChecks = new Map<string, number>(), healthFailures = new Map<string, number>(), healthResults = new Map<string, { at: number; ok: boolean }>(), healthSkips = new Map<string, number>();
  // The monitor heartbeat is in-memory observation only; it is never persisted.
  const iso = (time: number) => new Date(time).toISOString();
  function withHealth(item: EnvironmentRecord): EnvironmentSummary {
    const value = publicEnvironment(item), checked = healthResults.get(item.id), skipped = healthSkips.get(item.id);
    if (!checked && !skipped) return value;
    return { ...value, health: { ...(checked ? { checkedAt: iso(checked.at), ok: checked.ok, consecutiveFailures: healthFailures.get(item.id) || 0 } : {}), ...(skipped ? { skippedInUseAt: iso(skipped) } : {}) } };
  }
  function skipHealth(id: string) { if (!((healthSkips.get(id) || 0) >= (healthChecks.get(id) || 0))) healthSkips.set(id, Date.now()); }
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
  function quarantine(environment: EnvironmentRecord | undefined, error: string, step = 'Interrupted operation') {
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
  async function removeSnapshot(environment: EnvironmentRecord) {
    if (!UUID.test(environment.id)) throw new Error('Invalid environment storage ID.');
    const directory = join(root, environment.id);
    await rm(join(directory, 'source'), { recursive: true, force: true });
    await rmdir(directory).catch((error: NodeJS.ErrnoException) => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code ?? '')) throw error; });
  }
  function setPlan(scope: string, value: EnvironmentPlan) {
    const previous = state.plans[scope];
    state.plans[scope] = value;
    try { budget(); } catch (error) { if (previous === undefined) delete state.plans[scope]; else state.plans[scope] = previous; throw error; }
  }

  const scanKey = (scan: EnvironmentContext['scan'] | undefined) => JSON.stringify([scan?.repo?.sha || '', scan?.scannedAt || '']);
  async function planFor(context: Context) {
    const scope = scopeId(context), key = scanKey(context.scan);
    if (!state.plans[scope] || Object.hasOwn(state.detected, scope) && state.detected[scope] !== key) {
      setPlan(scope, await detectEnvironmentConfig(context.scan));
      state.detected[scope] = key;
      await persist();
    }
    return state.plans[scope];
  }
  function findEnvironment(context: StageRef, id: string, { idle = false } = {}) {
    const environment = state.environments.find(item => item.id === id && item.scope === scopeId(context));
    if (!environment) throw new Error('Environment not found in this stage.');
    if (idle && jobs.has(id)) throw conflict('This environment has an operation in progress.');
    return environment;
  }
  function track<T>(task: Promise<T>) {
    pending.add(task);
    task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
  }
  function enqueue(id: string, work: (release: () => void) => Promise<void>, { release = () => {}, onSettled }: { release?: () => void; onSettled?: () => Promise<void> } = {}) {
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
    summaries(key: string) { return state.environments.filter(item => item.pipelineKey === key).map(withHealth); },
    resolveTarget(url: unknown) {
      const origin = targetOrigin(url);
      if (!origin) return null;
      const environment = state.environments.find(item => (item.origins || []).includes(origin));
      return environment ? structuredClone(publicEnvironment(environment)) : null;
    },
    markUsageUncertain(id: string, error: unknown) {
      const environment = state.environments.find(item => item.id === id);
      if (!environment) return Promise.reject(new Error('Environment not found.'));
      quarantine(environment, `Environment use did not confirm completion. Delete the sandbox before retrying. ${failure(error)}`, 'Uncertain environment operation');
      // This settles already admitted work, including browser cleanup during
      // shutdown. A failed save must leave the in-memory quarantine in place.
      return track(persist());
    },
    async awaitIdle(id: string) {
      while (jobs.has(id)) await jobs.get(id);
      const environment = state.environments.find(item => item.id === id);
      if (!environment) throw new Error('Environment not found.');
      return structuredClone(publicEnvironment(environment));
    },
    async view(context: Context) {
      const scope = scopeId(context), plan = await planFor(context);
      return { environments: state.environments.filter(item => item.scope === scope).map(withHealth), plan };
    },
    async savePlan(context: Context, plan: unknown) {
      const config = validateTwinConfig(plan);
      setPlan(scopeId(context), config);
      delete state.detected[scopeId(context)];
      await persist();
      return { plan: config };
    },
    async create(context: Context) {
      context = structuredClone(context);
      const scope = scopeId(context);
      if (scopesBusy.has(scope) || state.environments.some(item => item.scope === scope && ['queued', 'creating', 'preparing', 'destroying'].includes(item.status))) throw conflict('This stage already has an environment operation in progress.');
      if (state.environments.filter(item => item.status !== 'destroyed' && !(item.status === 'failed' && (!item.sandboxId || item.cleanedAt))).length >= 8) throw new Error('Delete an environment before creating another (local limit: eight).');
      const id = randomUUID(), release = usage.acquire(context, { environmentId: id, operation: 'create' });
      // Set before any closure uses it; admission failures before that only compare against it.
      let queued = false, environment!: EnvironmentRecord, directoryCreated = false;
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
          let ready: Partial<EnvironmentRecord> | undefined;
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
    async destroy(context: StageRef, id: string, { removalToken = null }: { removalToken?: symbol | null } = {}) {
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
    async logs(context: StageRef, id: string) {
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
        let release: () => boolean;
        try { release = usage.acquire({ key: environment.pipelineKey, stageId: environment.stageId }, { environmentId: environment.id, operation: 'health' }); }
        catch (error) { if ((error as { statusCode?: number }).statusCode === 409) { skipHealth(environment.id); continue; } throw error; }
        healthChecks.set(environment.id, Date.now());
        try {
          let healthError: string | null = null;
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
  type Guarded = 'view' | 'logs' | 'savePlan' | 'create' | 'destroy' | 'tick';
  const reads = new Set<Guarded>(['view', 'logs']);
  const stageWrites = new Set<Guarded>(['savePlan']);
  // Each guarded method keeps its signature: the wrapper only admits, tracks or refuses the call.
  const guarded = manager as Record<Guarded, (...args: unknown[]) => Promise<unknown>>;
  for (const name of [...reads, ...stageWrites, 'create', 'destroy', 'tick'] as const) {
    const operation = guarded[name];
    guarded[name] = (...args) => {
      if (closed) return name === 'tick' ? Promise.resolve() : Promise.reject(conflict('The controller is shutting down.'));
      let release: (() => boolean) | undefined;
      try {
        if (stageWrites.has(name)) release = usage.acquire(args[0] as StageRef, { operation: name });
        return track(Promise.resolve(operation(...args)).finally(() => release?.()));
      } catch (error) { release?.(); return Promise.reject(error); }
    };
  }
  return manager;
}
export type EnvironmentManager = Awaited<ReturnType<typeof createEnvironmentManager>>;
