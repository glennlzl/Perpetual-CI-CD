// The controller runs only selected cases, so a one-off journey run selects its case
// for that run alone. The saved selection returns once the run leaves the queue.
export const MAX_RUN_CASES = 30;
const pending = new Map();
const scopeKey = (repoPath, stageId) => JSON.stringify([repoPath, stageId]);

export function oneOffSelection(cases, caseIds) {
  const added = caseIds.filter(id => cases.some(item => item.id === id && !item.selected));
  if (!added.length) return { added, cases };
  if (cases.filter(item => item.selected).length + added.length > MAX_RUN_CASES) return { added, cases, error: 'Deselect a test to run this one.' };
  return { added, cases: cases.map(item => added.includes(item.id) ? { ...item, selected: true } : item) };
}

// Null when nothing is left to undo, so an unchanged list is never saved.
export function restoreSelection(cases, added) {
  if (!cases.some(item => added.includes(item.id) && item.selected)) return null;
  return cases.map(item => added.includes(item.id) ? { ...item, selected: false } : item);
}

export function rememberOneOffRun(repoPath, stageId, runId, added, store = pending) {
  if (added.length) store.set(scopeKey(repoPath, stageId), { runId, caseIds: [...added] });
}

// Once the remembered run is no longer active, forgets it and returns the selection to restore.
export function settleOneOffRun(repoPath, stageId, { cases, runs, active }, store = pending) {
  const key = scopeKey(repoPath, stageId), entry = store.get(key);
  if (!entry || runs.some(run => run.id === entry.runId && active(run))) return null;
  store.delete(key);
  return restoreSelection(cases, entry.caseIds);
}
