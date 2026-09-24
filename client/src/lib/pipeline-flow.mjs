import { browserRunActive, environmentProvisioning } from './stage-activity.mjs';
import { gateActive } from './stage-gate.mjs';

// Edge motion maps to real work only: a current-commit GitHub run feeding
// Build & Deploy, provisioning and browser runs in a sandbox fed directly by
// Build & Deploy, or a journey gate rebuilding or running at a sandbox. Only a
// gate carries a commit from one sandbox to the next; otherwise a
// sandbox-to-sandbox edge never flows and that stage's card ring carries its activity.
export function transitionFlow(edge, { stages = [], snapshot = {}, build = null, latest = {}, sha = null, gates = null } = {}) {
  if (edge.blocked) return null;
  const source = stages.find(stage => stage.id === edge.source), target = stages.find(stage => stage.id === edge.target);
  if (!target || target.kind === 'production') return null;
  if (target.kind === 'build-deploy') return source?.kind === 'source' && ['running', 'queued'].includes(build?.status) ? 'active' : null;
  if (target.kind !== 'sandbox') return null;
  if (gateActive(gates?.stages?.[target.id])) return 'active';
  if (source?.kind === 'build-deploy' && ((snapshot.environments || []).some(item => item.stageId === target.id && environmentProvisioning(item.status))
    || (snapshot.browserTests?.[target.id]?.runs || []).some(browserRunActive))) return 'active';
  return environmentBehind(latest[target.id], sha) ? 'behind' : null;
}

export const environmentBehind = (environment, sha) => Boolean(environment?.status === 'ready' && environment.sourceRevision && sha && environment.sourceRevision !== sha);

// Keyed by environment id + updatedAt, so a transition flashes once per observation.
export function readyArrivals(seen, environments = []) {
  const next = new Map(), arrived = [];
  for (const item of environments) {
    next.set(item.id, item.status);
    if (seen && environmentProvisioning(seen.get(item.id)) && item.status === 'ready') arrived.push({ stageId: item.stageId, key: `${item.id}:${item.updatedAt}` });
  }
  return { seen: next, arrived };
}

export function shallowEqual(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && left[key] === right[key]);
}
