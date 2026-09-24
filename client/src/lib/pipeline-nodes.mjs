import { stageActivity } from './stage-activity.mjs';
import { environmentBehind, shallowEqual } from './pipeline-flow.mjs';

// One shared empty list: a fresh [] per recompute would give every sandbox and
// Production card new data on each unrelated poll.
const NO_SERVICES = Object.freeze([]);

export function stageServices(scan, stage) {
  if (stage.kind === 'source') return scan?.delivery?.source || NO_SERVICES;
  if (stage.kind === 'build-deploy') return scan?.delivery?.buildDeploy || NO_SERVICES;
  return NO_SERVICES;
}

// Where the scanned commit came from. It is a GitHub source only when the saved
// managed copy owns the scanned path; a GitHub remote alone is a local checkout.
export function sourceProvenance(scan, source = null) {
  const sha = typeof scan?.repo?.sha === 'string' ? scan.repo.sha : '';
  if (!sha) return { origin: '', revision: '' };
  return { origin: source?.scanPath && source.scanPath === scan.repo.path ? 'github' : 'local', revision: sha.slice(0, 7) };
}

export const STAGE_LIMIT = 12;

// The transition leaving a stage, as primitives. Its controls render inside the
// source card, so keyboard focus reaches them right after that stage's own
// controls. A stage is inserted only after Build & Deploy or a sandbox.
export function outgoingTransition(stage, pipeline) {
  const edge = pipeline?.transitions?.find(item => item.source === stage.id);
  const target = edge && pipeline.stages?.find(item => item.id === edge.target);
  if (!target) return { next: '', nextName: '', nextBlocked: false, canInsert: false, atStageLimit: false };
  return {
    next: target.id, nextName: target.name, nextBlocked: Boolean(edge.blocked),
    canInsert: ['build-deploy', 'sandbox'].includes(stage.kind), atStageLimit: pipeline.stages.length >= STAGE_LIMIT,
  };
}

// Card data for one stage. Fields are primitives or records the workspace
// reuses across polls; only Build & Deploy carries GitHub status. A Sandbox
// stage carries its journey gate and Production its readiness.
export function stageNodeData(stage, { scan, source = null, pipeline, sha = null, latest = {}, snapshot = {}, arrivals = {}, healthBeat = () => '', build = null, github = null, gates = null, selection = null, selectedStageId = null, busyStages = [], busy = false, openDialog, toggleStage, addTest, createSandbox }) {
  const environment = latest[stage.id], services = stageServices(scan, stage);
  return {
    stage, services, repoPath: scan?.repo?.path, scannedAt: scan?.scannedAt,
    blocked: Boolean(pipeline?.transitions?.some(edge => edge.target === stage.id && edge.blocked)),
    ...outgoingTransition(stage, pipeline),
    busy, openDialog, toggleStage, addTest, selected: stage.id === selectedStageId, selection, environment, createSandbox,
    environmentBusy: busyStages.includes(stage.id), browserTests: snapshot.browserTests?.[stage.id],
    activity: stageActivity(stage, snapshot), behind: environmentBehind(environment, sha) ? `${environment.sourceRevision.slice(0, 7)} → ${sha.slice(0, 7)}` : '',
    arrival: arrivals[stage.id] || '', beat: stage.kind === 'sandbox' ? healthBeat(environment) : '',
    gate: stage.kind === 'sandbox' ? gates?.stages?.[stage.id] || null : stage.kind === 'production' ? gates?.production || null : null,
    ...(stage.kind === 'source' ? sourceProvenance(scan, source) : {}),
    ...(stage.kind === 'build-deploy' ? { build, github } : {}),
  };
}

// Keeps a stage's previous data while every field is identical, so memoized
// cards skip polls that changed only other stages.
export function createStageDataCache() {
  const cache = new Map();
  return (id, next) => {
    const previous = cache.get(id), data = previous && shallowEqual(previous, next) ? previous : next;
    cache.set(id, data);
    return data;
  };
}

// What the canvas's live region says: only stages whose status text changed
// since the last observation. The first observation, and stages added or removed
// since, stay silent, so a poll that changed nothing announces nothing.
export function statusChanges(seen, statuses = []) {
  const next = new Map(statuses.map(item => [item.id, item.text]));
  const changed = seen ? statuses.filter(item => seen.has(item.id) && seen.get(item.id) !== item.text) : [];
  return { seen: next, message: changed.map(item => `${item.name}: ${item.text}`).join('. ') };
}
