import { join } from 'node:path';
import { createTwinInputs, createTwinRuntime, services as registry } from '../twin/index.mjs';
import { createBrowserModelSettings } from '../browser/model.mjs';
import { destroySandbox as destroyGuest } from '../sandbox/cua-local.mjs';
import { snapshotSource } from './plans.mjs';

const MODEL_SERVICE = 'llm';
const SETTINGS_SOURCE = 'settings';
/** The llm service takes App Settings' model unless its `source` option names the app's own values. */
export const fromAppSettings = (id, options) => id === MODEL_SERVICE && (options?.source ?? SETTINGS_SOURCE) === SETTINGS_SOURCE;

/** Stored test inputs by service; values go to the twin runtime only, never to a view. */
export async function environmentInputs({ dataDir, config, services = registry }) {
  const inputs = await createTwinInputs({ dataDir, services }).values();
  if (Object.hasOwn(config?.services ?? {}, MODEL_SERVICE) && fromAppSettings(MODEL_SERVICE, config.services[MODEL_SERVICE])) {
    const model = (await createBrowserModelSettings({ dataDir })).configuration();
    inputs[MODEL_SERVICE] = model.modelConfigured ? { OPENAI_BASE_URL: model.baseUrl, OPENAI_API_KEY: model.apiKey, OPENAI_MODEL: model.model } : {};
  }
  return inputs;
}

const describe = container => container.health === 'unhealthy' ? `${container.name} unhealthy`
  : `${container.name} ${container.state}${container.exitCode ? ` (${container.exitCode})` : ''}`;

// An environment's sandbox is its Compose twin, named by the environment's id. A different
// sandbox id is a Cua guest created before twins; it can only be deleted.
export function createEnvironmentRuntime({ services = registry, twin = createTwinRuntime({ services }), inputs = environmentInputs, destroyCuaGuest = destroyGuest } = {}) {
  const twinInputs = (dataDir, environment) => inputs({ dataDir, config: environment.plan, services });

  async function prepareEnvironment({ dataDir, environment, repoPath, directory, onUpdate, cancelled }) {
    const check = () => { if (cancelled()) throw new Error('Environment creation cancelled.'); };
    // How long each step took, kept as it goes, so a slow or failed twin shows where its time went.
    const timings = [];
    let current = { step: 'Copying source', at: Date.now() };
    const next = step => { const at = Date.now(); timings.push({ step: current.step, ms: at - current.at }); current = { step, at }; return { step, timings: [...timings] }; };
    check();
    await onUpdate({ status: 'creating', step: current.step, timings: [] });
    // Apps run from this snapshot for the twin's whole life; the user's checkout is never mounted.
    const source = join(directory, 'source');
    const snapshot = await snapshotSource(repoPath, source);
    check();
    // Record ownership before the twin allocates anything, so every later failure is cleaned up.
    await onUpdate({ status: 'preparing', ...next('Preparing twin'), snapshot, sandboxId: environment.id });
    const values = await twinInputs(dataDir, environment);
    check();
    const result = await twin.prepare({ dataDir, id: environment.id, config: environment.plan, source, inputs: values,
      onStep: async step => { check(); await onUpdate(next(step)); } });
    return { status: 'ready', ...next('Ready'), readyAt: new Date().toISOString(), apps: result.apps,
      services: result.services.map(({ id, fidelity, status, missing = [] }) => ({ id, title: services[id]?.title ?? id, fidelity, status, missing })),
      accounts: result.accounts ?? [] };
  }

  async function environmentHealth({ dataDir, environment }) {
    const { status, containers } = await twin.health({ dataDir, id: environment.id });
    if (status === 'ready') return { status };
    if (status === 'starting') return { status, error: 'The twin is restarting.' };
    const stopped = containers.filter(item => item.state !== 'running' || item.health === 'unhealthy').map(describe);
    return { status: 'failed', final: true, error: stopped.length ? `Stopped: ${stopped.join(', ')}.` : 'The twin is not running.' };
  }

  async function environmentLogs({ dataDir, environment }) {
    return twin.logs({ dataDir, id: environment.id });
  }

  async function destroySandbox({ dataDir, environment }) {
    if (environment.sandboxId !== environment.id) return destroyCuaGuest({ dataDir, id: environment.sandboxId });
    return twin.destroy({ dataDir, id: environment.id, inputs: await twinInputs(dataDir, environment) });
  }

  return { prepareEnvironment, environmentHealth, environmentLogs, destroySandbox };
}

export const { prepareEnvironment, environmentHealth, environmentLogs, destroySandbox } = createEnvironmentRuntime();
