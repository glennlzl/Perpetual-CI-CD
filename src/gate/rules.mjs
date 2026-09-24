// A journey gate decides whether one commit may leave one Sandbox stage.
// queued -> rebuilding -> running -> passed | failed | needs-release -> released; a queued gate
// is superseded when a newer commit reaches its stage.

export const SHA = /^[a-f\d]{40}$/i;
export const ACTIVE = Object.freeze(['rebuilding', 'running']);
export const PROMOTED = Object.freeze(['passed', 'released']);
export const short = sha => String(sha).slice(0, 7);

const RUN_REASONS = {
  blocked: 'A journey is blocked.',
  needs_review: 'A journey needs review.',
  cancelled: 'The run was cancelled.',
  completed: 'A journey was skipped.',
};

/**
 * The gate a run's roll-up implies: a failed journey fails; blocked and unreviewed results need a person.
 * A run that stopped without a failed journey, such as a browser runtime error, is no journey verdict.
 */
export function verdict(run) {
  if (run?.status === 'passed') return { status: 'passed' };
  const failed = (run?.results || []).find(result => result.status === 'failed');
  if (run?.status === 'failed' && failed) return { status: 'failed', reason: failed.error || run.error || 'A journey failed.' };
  return { status: 'needs-release', reason: RUN_REASONS[run?.status] || run?.error || 'Journeys did not all pass.' };
}

const STATUSES = {
  rebuilding: ['pending', 'Running'],
  running: ['pending', 'Running'],
  passed: ['success', 'Passed'],
  failed: ['failure', 'Failed'],
  'needs-release': ['pending', 'Needs release'],
};

/** The GitHub commit status a gate reports; queued and superseded gates report nothing. */
export function commitStatus(gate) {
  if (gate?.status === 'released') return { state: 'success', context: gate.context, description: `Released by ${gate.releasedBy}` };
  const status = STATUSES[gate?.status];
  return status ? { state: status[0], context: gate.context, description: status[1] } : null;
}

export const sameStatus = (left, right) => Boolean(left && right) && ['state', 'context', 'description'].every(key => left[key] === right[key]);

const newest = (a, b) => b.detectedAt.localeCompare(a.detectedAt) || b.updatedAt.localeCompare(a.updatedAt);

/** The gate a stage shows: the one at work, else its newest commit's. */
export function stageGate(gates) {
  return gates.find(gate => ACTIVE.includes(gate.status)) || gates.filter(gate => gate.status !== 'superseded').sort(newest)[0] || null;
}

/** The next gate to run: later stages first, so a commit leaves the pipeline before another enters it. */
export function nextGate(gates, sandboxIds) {
  return gates.filter(gate => gate.status === 'queued' && sandboxIds.includes(gate.stageId))
    .sort((a, b) => sandboxIds.indexOf(b.stageId) - sandboxIds.indexOf(a.stageId) || newest(a, b))[0] || null;
}

/** Production is Ready for the newest commit that every Sandbox gate passed or released. */
export function productionReady(gates, sandboxIds) {
  if (!sandboxIds.length) return null;
  const shas = [...new Set(gates.filter(gate => gate.status !== 'superseded').sort(newest).map(gate => gate.sha))];
  const sha = shas.find(value => sandboxIds.every(stageId => gates.some(gate => gate.stageId === stageId && gate.sha === value && PROMOTED.includes(gate.status))));
  return sha ? { sha, status: 'ready' } : null;
}
