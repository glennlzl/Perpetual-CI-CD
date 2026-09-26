// The journey gate as GET /api/gate replies with it. The controller implements these shapes
// (src/gate) and the client reads them (client/src/lib/stage-gate.ts). Types only: Node strips
// the file and Vite erases the imports, so both sides may only `import type` from it.

export type GateStatus = 'queued' | 'rebuilding' | 'running' | 'passed' | 'failed' | 'needs-release' | 'released' | 'superseded';
/** One Sandbox stage's gate for one commit. */
export interface StageGate {
  id: string; stageId: string; sha: string; status: GateStatus; reason?: string; statusError?: string;
  releasedBy?: string; releasedAt?: string; detectedAt: string; updatedAt: string;
}
/** Production's readiness: the newest commit every Sandbox gate passed or released. */
export interface ProductionGate { sha: string; status: 'ready' }
export interface GateView { stages: Record<string, StageGate>; production: ProductionGate | null; watchError?: string }
/** GET /api/gate: the view for the active source, which the reply names so a page on an older commit reloads it. */
export interface GateReply extends GateView { repoPath: string; sha: string | null }
