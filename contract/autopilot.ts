// Autopilot as the controller records it: GET /api/autopilot?repoPath= replies with an
// AutopilotView, GET /api/state carries the same view as `autopilot`, and POST /api/autopilot/mode
// takes { repoPath, stageId, mode }. The client reads these shapes (client/src/lib/pipeline-autopilot.ts);
// the controller side is designed in docs/architecture/autopilot.md. Types only.

/** How a stage handles the changes Autopilot makes: merge them once verified, or open them and ask. */
export type AutopilotMode = 'merge' | 'ask';
/** A step is still to come, under way, done, failed, or waiting for a person. */
export type StepStatus = 'pending' | 'active' | 'done' | 'failed' | 'waiting';
/** A piece of a step's detail: text, or a fact set in a mono chip, linked when it has an https address. */
export type DetailPart = string | { text: string; href?: string };
export interface ChangeStep { id: string; name: string; status: StepStatus; detail?: DetailPart[] }
/** A change is under way, merged, opened for a person's review, or left unmerged. */
export type ChangeStatus = 'running' | 'merged' | 'needs-review' | 'not-merged';
/** A change Autopilot makes for a stage: a pull request and the steps that led to it. `title` names the work, such as Fixing build. */
export interface AutopilotChange {
  id: string; stageId: string; kind: string; title: string; status: ChangeStatus; steps: ChangeStep[];
  pullRequest?: { number: number; url: string } | null; reason?: string; startedAt?: string; endedAt?: string;
}
/** A stage's Autopilot: its mode and its current changes, newest first. */
export interface StageAutopilot { mode: AutopilotMode; changes: AutopilotChange[] }
export interface AutopilotView { repoPath?: string; stages?: Record<string, StageAutopilot> }
