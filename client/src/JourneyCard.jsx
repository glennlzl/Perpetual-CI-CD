import { useEffect, useState } from 'react';
import { ChevronDown, LoaderCircle, Maximize2, SkipForward } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { browserJourneySteps, browserRunLabel, journeyActive, journeyCode, journeyErrorTone, journeyOpenByDefault, journeyProgress, journeyQueueLabel, journeyRecordings, journeyRevision } from '@/lib/browser-test-ui';
import BrowserLiveFrame from './BrowserLiveFrame';
import JourneyRecording from './JourneyRecording';
import JourneyEvidence, { hasJourneyEvidence } from './JourneyEvidence';
import JourneySteps, { JourneyBlockers, JourneyMark } from './JourneySteps';

// The journey's Playwright code: its state next to the engine, a running generation, or why generation failed.
function JourneyCode({ spec }) {
  const { state, generating, error } = journeyCode(spec);
  if (!state && !generating && !error) return null;
  return <div className="space-y-1">
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge variant="outline">Playwright</Badge>
      {state && <Badge variant={state === 'Approved' ? 'secondary' : 'outline'}>{state}</Badge>}
      {generating && <Badge variant="secondary"><LoaderCircle className="motion-safe:animate-spin" />Generating</Badge>}
      {error && <Badge variant="destructive">Generation failed</Badge>}
    </div>
    {error && <p className="break-words text-xs text-destructive">{error}</p>}
  </div>;
}

export default function JourneyCard({ item, run, status, label, repoPath, stageId, selection, actions, spec, onSkip, skipping, onInspect, onViewRun, onFocus, focusRef, focused = false }) {
  const progress = journeyProgress(run, item.id);
  const statusLabel = label || browserRunLabel(status);
  const badge = <Badge variant={status === 'failed' ? 'destructive' : 'outline'} className="shrink-0"><JourneyMark status={status} />{statusLabel}</Badge>;
  const result = run?.results?.find(value => value.caseId === item.id);
  const steps = browserJourneySteps(item, progress, status);
  const recordings = journeyRecordings({ repoPath, stageId, run, caseId: item.id, status });
  // Only live or failed journeys open by default; a later start or failure reopens the card.
  const attention = journeyOpenByDefault(status);
  const [open, setOpen] = useState(attention);
  useEffect(() => { if (attention) setOpen(true); }, [attention]);
  return <Card className="journey-card gap-0 overflow-hidden py-0 shadow-none" data-status={status} data-case-id={item.id} data-focused={focused || undefined} tabIndex={-1}>
    <Collapsible open={open} onOpenChange={setOpen}>
      <CardHeader className="flex flex-row items-start gap-2 px-4 py-3">
        {selection}
        {/* The title opens the case's review/edit view; the status opens its run; the chevron only expands. */}
        <CardTitle className="min-w-0 flex-1 break-words text-sm leading-5">{onInspect
          ? <Button variant="link" className="h-auto min-w-0 max-w-full justify-start whitespace-normal p-0 text-left text-sm leading-5 font-semibold text-foreground" aria-label={`${item.name}: ${item.needsReview ? 'Review' : 'Edit'}`} onClick={onInspect}>{item.name}</Button>
          : item.name}</CardTitle>
        {onViewRun ? <Button variant="ghost" size="sm" className="-my-1 h-7 shrink-0 rounded-full px-0.5" aria-label={`View run for ${item.name}: ${statusLabel}`} onClick={onViewRun}>{badge}</Button> : badge}
        {onFocus && <Button ref={focusRef} variant="ghost" size="icon-sm" className="-my-1.5 shrink-0" aria-label={`Focus ${item.name}`} onClick={onFocus}><Maximize2 /></Button>}
        {actions}
        <CollapsibleTrigger asChild><Button variant="ghost" size="icon-sm" className="-my-1.5 shrink-0 text-muted-foreground [&[data-state=open]>svg]:rotate-180" aria-label={`${item.name} details`}><ChevronDown className="transition-transform" /></Button></CollapsibleTrigger>
      </CardHeader>
      <CollapsibleContent>
        {run && (recordings.length ? <JourneyRecording key={`${run.id}:${item.id}`} urls={recordings} name={item.name} /> : <BrowserLiveFrame collapseEmpty repoPath={repoPath} stageId={stageId} runId={run.id} caseId={item.id} name={item.name} status={status} revision={journeyRevision(progress)} updatedAt={progress?.frameCapturedAt || progress?.frameUpdatedAt} />)}
        <CardContent className="space-y-3 px-4 py-4">
          <JourneyCode spec={spec} />
          <JourneySteps steps={steps} name={item.name} />
          <JourneyBlockers result={result} steps={steps} />
          {(result?.error || progress?.error) && <p className={`break-words text-xs leading-5 ${journeyErrorTone(status)}`}>{result?.error || progress?.error}</p>}
          {progress?.queueReason && status === 'queued' && <Badge variant="outline">{journeyQueueLabel(progress.queueReason)}</Badge>}
          {hasJourneyEvidence(result, progress) && <Collapsible>
            <CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="h-8 w-full justify-between px-0 text-xs hover:bg-transparent [&[data-state=open]>svg]:rotate-180">Evidence<ChevronDown className="size-3.5 transition-transform" /></Button></CollapsibleTrigger>
            <CollapsibleContent className="pt-1"><JourneyEvidence item={item} result={result} progress={progress} /></CollapsibleContent>
          </Collapsible>}
          {onSkip && journeyActive(status) && <div className="flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" className="h-8 text-xs" disabled={skipping || ['skipping','cancelling'].includes(status)} onClick={onSkip}><SkipForward />{skipping || status === 'skipping' ? 'Skipping…' : 'Skip'}</Button>
          </div>}
        </CardContent>
      </CollapsibleContent>
    </Collapsible>
  </Card>;
}
