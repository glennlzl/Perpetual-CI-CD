// The controller runs only selected cases, so a one-off journey run selects its case
// for that run alone. The saved selection returns once the run leaves the queue.
export const MAX_RUN_CASES = 30;
/** A one-off run and the cases it selected for itself. */
export interface OneOffRun { runId: string; caseIds: string[] }
type Selectable = { id: string; selected?: boolean };
const pending = new Map<string, OneOffRun>();
const scopeKey = (repoPath: string, stageId: string) => JSON.stringify([repoPath, stageId]);

export function oneOffSelection<T extends Selectable>(cases: T[], caseIds: string[]): { added: string[]; cases: T[]; error?: string } {
  const added = caseIds.filter(id => cases.some(item => item.id === id && !item.selected));
  if (!added.length) return { added, cases };
  if (cases.filter(item => item.selected).length + added.length > MAX_RUN_CASES) return { added, cases, error: 'Deselect a test to run this one.' };
  return { added, cases: cases.map(item => added.includes(item.id) ? { ...item, selected: true } : item) };
}

// Null when nothing is left to undo, so an unchanged list is never saved.
export function restoreSelection<T extends Selectable>(cases: T[], added: string[]): T[] | null {
  if (!cases.some(item => added.includes(item.id) && item.selected)) return null;
  return cases.map(item => added.includes(item.id) ? { ...item, selected: false } : item);
}

export function rememberOneOffRun(repoPath: string, stageId: string, runId: string, added: string[], store: Map<string, OneOffRun> = pending) {
  if (added.length) store.set(scopeKey(repoPath, stageId), { runId, caseIds: [...added] });
}

// Once the remembered run is no longer active, forgets it and returns the selection to restore.
export function settleOneOffRun<T extends Selectable, R extends { id: string }>(repoPath: string, stageId: string, { cases, runs, active }: { cases: T[]; runs: R[]; active: (run: R) => boolean }, store: Map<string, OneOffRun> = pending) {
  const key = scopeKey(repoPath, stageId), entry = store.get(key);
  if (!entry || runs.some(run => run.id === entry.runId && active(run))) return null;
  store.delete(key);
  return restoreSelection(cases, entry.caseIds);
}
