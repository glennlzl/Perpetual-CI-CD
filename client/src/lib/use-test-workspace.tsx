import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import type { Resource, StageHandle, StageView, TestWorkspace, WorkspaceSnapshot } from './test-workspace.ts';

export const TestWorkspaceContext = createContext<TestWorkspace | null>(null);

function useWorkspace(): TestWorkspace {
  const workspace = useContext(TestWorkspaceContext);
  if (!workspace) throw new Error('A test workspace is required.');
  return workspace;
}

export function useTestWorkspace(): [TestWorkspace, WorkspaceSnapshot] {
  const workspace = useWorkspace();
  const snapshot = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  return [workspace, snapshot];
}

// A stage that is gone (undefined) reads as an empty stage no request names.
export function useTestStage(stageId: string | undefined, resources: Resource[] = []): [StageHandle, StageView] {
  const [workspace] = useTestWorkspace();
  const stage = workspace.stage(stageId ?? '');
  const snapshot = useSyncExternalStore(stage.subscribe, stage.getSnapshot);
  // The key joins resource names, so its parts are those names again.
  const resourceKey = resources.join(',');
  useEffect(() => resourceKey ? stage.observe(resourceKey.split(',') as Resource[]) : undefined, [stage, resourceKey]);
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
