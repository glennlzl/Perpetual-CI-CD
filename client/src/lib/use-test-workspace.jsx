import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';

export const TestWorkspaceContext = createContext(null);

function useWorkspace() {
  const workspace = useContext(TestWorkspaceContext);
  if (!workspace) throw new Error('A test workspace is required.');
  return workspace;
}

export function useTestWorkspace() {
  const workspace = useWorkspace();
  const snapshot = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  return [workspace, snapshot];
}

export function useTestStage(stageId, resources = []) {
  const [workspace] = useTestWorkspace();
  const stage = workspace.stage(stageId);
  const snapshot = useSyncExternalStore(stage.subscribe, stage.getSnapshot);
  const resourceKey = resources.join(',');
  useEffect(() => resourceKey ? stage.observe(resourceKey.split(',')) : undefined, [stage, resourceKey]);
  return [stage, snapshot];
}

// Scanned preview URLs only, so unrelated workspace updates never re-render the reader.
export function useSourcePreviews() {
  const workspace = useWorkspace();
  return useSyncExternalStore(workspace.subscribe, () => workspace.getSnapshot().previews);
}

// The scanned branch, so a known URL deploying another branch can be flagged.
export function useSourceBranch() {
  const workspace = useWorkspace();
  return useSyncExternalStore(workspace.subscribe, () => workspace.getSnapshot().branch);
}
