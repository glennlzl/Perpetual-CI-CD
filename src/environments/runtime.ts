import { join } from 'node:path';
import { createTwinInputs, createTwinRuntime, services as registry } from '../twin/index.ts';
import { createBrowserModelSettings } from '../browser/model.ts';
import { destroySandbox as destroyGuest } from '../sandbox/cua-local.ts';
import { snapshotSource } from './plans.ts';
import type { EnvironmentAccount, EnvironmentApp, EnvironmentRecord, EnvironmentService, StepTiming } from './manager.ts';
import type { JsonObject } from '../twin/config.ts';
import type { TwinRuntime, TwinServices } from '../twin/index.ts';
import type { ContainerStatus } from '../twin/runtime.ts';
import type { InputValues } from '../twin/registry.ts';
import type { ServiceSummary } from '../twin/compose.ts';

const MODEL_SERVICE = 'llm';
const SETTINGS_SOURCE = 'settings';
/** The llm service takes App Settings' model unless its `source` option names the app's own values. */
export const fromAppSettings = (id: string, options: { source?: unknown } | null | undefined) => id === MODEL_SERVICE && (options?.source ?? SETTINGS_SOURCE) === SETTINGS_SOURCE;

/** Stored test inputs by service; values go to the twin runtime only, never to a view. First renews each provision
 * of the config's services that is about to expire, so every twin creation, a gate's rebuild included, keeps a
 * provisioned sandbox with no user action; a renewal that fails leaves its service blocked. A view or a teardown
 * passes `refresh: false`, since neither may create anything. */
export async function environmentInputs({ dataDir, config, services = registry, refresh = true, store = createTwinInputs({ dataDir, services }) }: {
  dataDir: string; config?: { services?: Record<string, JsonObject> } | null; services?: TwinServices; refresh?: boolean;
  store?: { refresh(ids: string[]): Promise<unknown>; values(): Promise<Record<string, InputValues>> };
}) {
  const declared = config?.services ?? {};
  if (refresh) await store.refresh(Object.keys(declared));
  const inputs = await store.values();
  if (Object.hasOwn(declared, MODEL_SERVICE) && fromAppSettings(MODEL_SERVICE, declared[MODEL_SERVICE])) {
    const model = (await createBrowserModelSettings({ dataDir })).configuration();
    inputs[MODEL_SERVICE] = model.modelConfigured ? { OPENAI_BASE_URL: model.baseUrl, OPENAI_API_KEY: model.apiKey, OPENAI_MODEL: model.model } : {};
  }
  return inputs;
}

type Container = Pick<ContainerStatus, 'name' | 'state' | 'health'> & { exitCode?: number | null };
const describe = (container: Container) => container.health === 'unhealthy' ? `${container.name} unhealthy`
  : `${container.name} ${container.state}${container.exitCode ? ` (${container.exitCode})` : ''}`;

/** What preparing an environment reports once its twin is ready. */
export interface PreparedEnvironment {
  status: 'ready'; step: string; timings: StepTiming[]; readyAt: string; apps: EnvironmentApp[]; services: EnvironmentService[]; accounts: EnvironmentAccount[];
}
/** A health check: `final` says the twin will not recover by itself. */
export interface EnvironmentHealth { status: 'ready' | 'starting' | 'failed'; error?: string; final?: boolean }
/** An environment as its runtime reads it: the twin validates the plan. */
type Environment = Pick<EnvironmentRecord, 'id' | 'sandboxId'> & { plan?: { services?: Record<string, JsonObject> } };
type TwinCall = { dataDir: string; id: string };
/** What environments call on their twin runtime (../twin/runtime.ts). */
export interface EnvironmentTwin {
  prepare(options: Parameters<TwinRuntime['prepare']>[0]): Promise<{ services: ServiceSummary[]; apps: EnvironmentApp[]; accounts?: EnvironmentAccount[] }>;
  health(options: TwinCall): Promise<{ status: string; containers: Container[] }>;
  logs(options: TwinCall): Promise<string>;
  destroy(options: TwinCall & { inputs?: Record<string, InputValues> }): Promise<unknown>;
}

// An environment's sandbox is its Compose twin, named by the environment's id. A different
// sandbox id is a Cua guest created before twins; it can only be deleted.
export function createEnvironmentRuntime({ services = registry, twin = createTwinRuntime({ services }), inputs = environmentInputs, destroyCuaGuest = destroyGuest }: {
  services?: TwinServices; twin?: EnvironmentTwin; inputs?: typeof environmentInputs;
  destroyCuaGuest?: (options: { dataDir: string; id?: string }) => Promise<unknown>;
} = {}) {
  const twinInputs = (dataDir: string, environment: Environment, refresh: boolean) => inputs({ dataDir, config: environment.plan, services, refresh });

  async function prepareEnvironment({ dataDir, environment, repoPath, directory, onUpdate, cancelled }: {
    dataDir: string; environment: Environment; repoPath: string; directory: string; onUpdate: (update: Partial<EnvironmentRecord>) => Promise<void>; cancelled: () => boolean;
  }): Promise<PreparedEnvironment> {
    const check = () => { if (cancelled()) throw new Error('Environment creation cancelled.'); };
    // How long each step took, kept as it goes, so a slow or failed twin shows where its time went.
    const timings: StepTiming[] = [];
    let current = { step: 'Copying source', at: Date.now() };
    const next = (step: string) => { const at = Date.now(); timings.push({ step: current.step, ms: at - current.at }); current = { step, at }; return { step, timings: [...timings] }; };
    check();
    await onUpdate({ status: 'creating', step: current.step, timings: [] });
    // Apps run from this snapshot for the twin's whole life; the user's checkout is never mounted.
    const source = join(directory, 'source');
    const snapshot = await snapshotSource(repoPath, source);
    check();
    // Record ownership before the twin allocates anything, so every later failure is cleaned up.
    await onUpdate({ status: 'preparing', ...next('Preparing twin'), snapshot, sandboxId: environment.id });
    const values = await twinInputs(dataDir, environment, true);
    check();
    const result = await twin.prepare({ dataDir, id: environment.id, config: environment.plan, source, inputs: values,
      onStep: async step => { check(); await onUpdate(next(step)); } });
    return { status: 'ready', ...next('Ready'), readyAt: new Date().toISOString(), apps: result.apps,
      services: result.services.map(({ id, fidelity, status, missing = [] }) => ({ id, title: services[id]?.title ?? id, fidelity, status, missing })),
      accounts: result.accounts ?? [] };
  }

  async function environmentHealth({ dataDir, environment }: { dataDir: string; environment: Environment }): Promise<EnvironmentHealth> {
    const { status, containers } = await twin.health({ dataDir, id: environment.id });
    if (status === 'ready') return { status };
    if (status === 'starting') return { status, error: 'The twin is restarting.' };
    const stopped = containers.filter(item => item.state !== 'running' || item.health === 'unhealthy').map(describe);
    return { status: 'failed', final: true, error: stopped.length ? `Stopped: ${stopped.join(', ')}.` : 'The twin is not running.' };
  }

  async function environmentLogs({ dataDir, environment }: { dataDir: string; environment: Environment }) {
    return twin.logs({ dataDir, id: environment.id });
  }

  async function destroySandbox({ dataDir, environment }: { dataDir: string; environment: Environment }) {
    if (environment.sandboxId !== environment.id) return destroyCuaGuest({ dataDir, id: environment.sandboxId });
    return twin.destroy({ dataDir, id: environment.id, inputs: await twinInputs(dataDir, environment, false) });
  }

  return { prepareEnvironment, environmentHealth, environmentLogs, destroySandbox };
}
export type EnvironmentRuntime = ReturnType<typeof createEnvironmentRuntime>;

export const { prepareEnvironment, environmentHealth, environmentLogs, destroySandbox } = createEnvironmentRuntime();
