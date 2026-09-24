import { useEffect, useState } from 'react';
import { Play, SkipForward } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useTestStage } from '@/lib/use-test-workspace';
import { useNow } from '@/lib/use-now';
import { browserActionFailure, browserActionLabel, browserCaseRun, browserCaseState, browserJourneySteps, browserRunLabel, journeyActive, journeyElapsed, journeyLastAction, journeyProgress, journeyQueueLabel, journeyRevision, journeyStreaming, journeySummary } from '@/lib/browser-test-ui';
import BrowserLiveFrame from './BrowserLiveFrame';
import { JourneyMark, JourneySegments } from './JourneySteps';
import { StepItem } from './StepList';

// The newest action label replaces the previous one with a short crossfade keyed on a real action event.
function CrossfadeText({ value, changeKey, className = '' }) {
  const key = `${changeKey}:${value}`;
  const [items, setItems] = useState(() => [{ key, value }]);
  useEffect(() => { setItems(current => current.at(-1).key === key ? current : [{ ...current.at(-1), leaving: true }, { key, value }]); }, [key, value]);
  useEffect(() => {
    if (items.length < 2) return undefined;
    const timer = setTimeout(() => setItems(current => current.slice(-1)), 200);
    return () => clearTimeout(timer);
  }, [items]);
  return <span className={`journey-crossfade ${className}`}>{items.map(item => <span key={item.key} data-leaving={item.leaving || undefined} aria-hidden={item.leaving || undefined}>{item.value}</span>)}</span>;
}

export default function StageJourney({ item, runs, repoPath, stageId, selected, disabled = false, onOpen, onRun, onWatch }) {
  const [stage, snapshot] = useTestStage(stageId);
  const run = browserCaseRun(item, runs);
  const state = browserCaseState(item, runs);
  const progress = journeyProgress(run, item.id);
  const steps = browserJourneySteps(item, progress, state.status);
  const summary = run ? journeySummary(steps, state.status) : { text: '' };
  const live = journeyStreaming(state.status);
  const now = useNow(live);
  const action = live ? journeyLastAction(progress) : null;
  async function skip() {
    try { await stage.perform('browser', 'skip', tx => tx.post('skip', { id: run.id, caseId: item.id })); }
    catch { /* Shared workspace displays the controller error. */ }
  }
  return <StepItem compact icon={<JourneyMark status={state.status} />} className={live ? 'journey-stage-active' : ''}>
    <div className="flex min-w-0 items-start gap-1">
      {/* The name opens the case's review/edit view; with a current run, the status badge opens that run. */}
      <Button variant="ghost" size="sm" className="stage-case-action nodrag nopan h-auto min-h-8 min-w-0 flex-1 justify-between gap-3 whitespace-normal px-1 py-1 text-left" aria-label={run ? `Open integration test ${item.name}` : `Open integration test ${item.name}: ${state.label}`} data-selected={selected} onClick={onOpen}>
        <span className="min-w-0 max-w-64 break-words leading-5">{item.name}</span>{!run && <Badge variant={state.variant} className="shrink-0">{state.label}</Badge>}
      </Button>
      {run && <Button variant="ghost" size="sm" className="nodrag nopan h-auto min-h-8 shrink-0 items-start px-1 py-1.5" aria-label={`View run for ${item.name}: ${state.label}`} onClick={() => onWatch?.(run)}><Badge variant={state.variant} className="mt-0.5">{state.label}</Badge></Button>}
      {run && journeyActive(state.status)
        ? <Button variant="ghost" size="icon-sm" className="nodrag nopan mt-0.5 shrink-0" aria-label={`Skip ${item.name}`} disabled={Boolean(snapshot.pending) || ['skipping','cancelling'].includes(state.status)} onClick={skip}><SkipForward className="size-3.5" /></Button>
        : onRun && !item.needsReview && <Button variant="ghost" size="icon-sm" className="nodrag nopan mt-0.5 shrink-0" aria-label={`Run ${item.name}`} disabled={disabled} onClick={onRun}><Play className="size-3.5" /></Button>}
    </div>
    {live && <div className="journey-live grid min-w-0 gap-1.5 px-1 pt-1">
      <JourneySegments steps={steps} />
      <div className="flex min-w-0 items-start justify-between gap-3 text-xs leading-5 text-muted-foreground">
        <span className="min-w-0 break-words">{summary.text || browserRunLabel(state.status)}</span>
        <span className="shrink-0 tabular-nums">{journeyElapsed(progress?.startedAt, now)}</span>
      </div>
      {action && <CrossfadeText className="text-xs leading-5 text-foreground" changeKey={`${action.count}:${action.status}`} value={`${browserActionLabel(action.type)}${browserActionFailure(action) ? ` · ${browserActionFailure(action)}` : ''}`} />}
      <BrowserLiveFrame variant="compact" repoPath={repoPath} stageId={stageId} runId={run.id} caseId={item.id} name={item.name} status={state.status} revision={journeyRevision(progress)} updatedAt={progress?.frameCapturedAt || progress?.frameUpdatedAt} onOpen={() => onWatch?.(run)} />
    </div>}
    {state.status === 'queued' && progress?.queueReason && <span className="px-1 text-xs leading-5 text-muted-foreground">{journeyQueueLabel(progress.queueReason)}</span>}
    {!journeyActive(state.status) && summary.text && <span className={`flex min-w-0 items-start gap-1.5 px-1 text-xs leading-5 ${summary.status ? 'text-foreground' : 'text-muted-foreground'}`}>{summary.status && <span className="mt-[3px]"><JourneyMark status={summary.status} /></span>}<span className="min-w-0 break-words">{summary.text}</span></span>}
  </StepItem>;
}
