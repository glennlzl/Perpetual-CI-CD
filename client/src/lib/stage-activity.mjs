// Stage motion derives only from controller records: environment lifecycle,
// browser preparation and runs, and confirmed stage removal.
const PROVISIONING = ['queued', 'creating', 'preparing'];
const activeRun = run => ['queued', 'running'].includes(run?.status);

export const environmentWorking = status => [...PROVISIONING, 'destroying'].includes(status);
export const environmentProvisioning = status => PROVISIONING.includes(status);
export const browserRunActive = activeRun;

export function stageActivity(stage, snapshot = {}) {
  if (stage?.kind !== 'sandbox') return null;
  const environments = (snapshot.environments || []).filter(item => item.stageId === stage.id);
  const tests = snapshot.browserTests?.[stage.id];
  const runs = (tests?.runs || []).filter(activeRun);
  if ((snapshot.stageRemovals || []).some(item => item.stageId === stage.id && ['queued', 'removing'].includes(item.status))
    || environments.some(item => item.status === 'destroying')) return 'removing';
  if (environments.some(item => PROVISIONING.includes(item.status))) return 'provisioning';
  if (runs.some(run => run.mode === 'run')) return 'testing';
  if (runs.some(run => run.mode === 'discover') || ['preparing', 'discovering'].includes(tests?.preparation?.status)) return 'discovering';
  return null;
}
