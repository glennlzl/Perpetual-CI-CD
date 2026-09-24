// Ephemeral edits survive closing a dialog; never persist test inputs in browser storage.
export const caseDrafts = new Map();
// A new test's unsent description, kept on every close until it is generated or discarded.
export const newTestDrafts = new Map();
export const hasCaseDrafts = () => caseDrafts.size > 0 || newTestDrafts.size > 0;
export const caseDraftKey = (repoPath, stageId, caseId) => JSON.stringify([repoPath, stageId, caseId]);
export const newTestDraftKey = (repoPath, stageId) => JSON.stringify([repoPath, stageId]);
export const caseDraftOriginal = ({ selected: _selected, ...definition }) => JSON.stringify(definition);

// A draft of a deleted or changed case can never be saved, so it must not keep the unload prompt alive.
export function pruneCaseDrafts(repoPath, stageId, cases, drafts = caseDrafts) {
  const scope = JSON.stringify([repoPath, stageId]).slice(0, -1) + ',';
  const originals = new Map(cases.map(item => [caseDraftKey(repoPath, stageId, item.id), caseDraftOriginal(item)]));
  for (const [key, value] of drafts) if (key.startsWith(scope) && originals.get(key) !== value.original) drafts.delete(key);
}

// Neither a case draft nor an unsent description of a stage that left the pipeline can be saved or
// sent, so both are dropped once the source's pipeline no longer lists that stage.
export function pruneStageDrafts(repoPath, stageIds, maps = [caseDrafts, newTestDrafts]) {
  const kept = new Set(stageIds);
  for (const drafts of maps) for (const key of drafts.keys()) {
    let scope;
    try { scope = JSON.parse(key); } catch { continue; }
    if (Array.isArray(scope) && scope[0] === repoPath && !kept.has(scope[1])) drafts.delete(key);
  }
}
