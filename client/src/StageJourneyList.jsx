import { ChevronDown, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { JOURNEY_GENERATE_REQUEST, browserUnavailable, journeyRunRequest, stageJourneyGroups } from '@/lib/browser-test-ui';
import { useTestStage } from '@/lib/use-test-workspace';
import StageJourney from './StageJourney';
import { StepList } from './StepList';

// Reviewed journeys are the stage's primary rows. Step-less legacy cases and drafts
// remain reachable in one collapsed group beside the regeneration entry point.
export default function StageJourneyList({ repoPath, stageId, stageName, cases = [], runs = [], selection, busy = false, openDialog }) {
  // Generate and Run share the panel's gates once its capabilities are known.
  const [, snapshot] = useTestStage(stageId);
  const disabled = busy || Boolean(browserUnavailable(snapshot.browser.capabilities));
  if (!cases.length) return null;
  const { journeys, others } = stageJourneyGroups(cases, runs);
  const open = request => openDialog({ type: 'environment', stageId, tab: 'browser', ...request });
  const row = item => <StageJourney key={item.id} item={item} runs={runs} repoPath={repoPath} stageId={stageId} selected={selection?.caseId === item.id} disabled={disabled} onOpen={() => open({ caseId: item.id })} onRun={() => open({ caseId: journeyRunRequest(item.id) })} onWatch={run => open({ runId: run.id, watch: true, caseId: item.id })} />;
  return <>
    {!!journeys.length && <StepList label={`${stageName} journeys`}>{journeys.map(row)}</StepList>}
    {!!others.length && <Collapsible defaultOpen={false} className="nodrag nopan min-w-0">
      <div className="flex items-center justify-between gap-2">
        <CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="h-8 justify-start gap-2 px-1 text-xs [&[data-state=open]>svg]:rotate-180" aria-label={`Other tests in ${stageName}`}>Other tests<Badge variant="secondary">{others.length}</Badge><ChevronDown className="size-3.5 text-muted-foreground transition-transform" /></Button></CollapsibleTrigger>
        <Button variant="outline" size="sm" className="h-8 text-xs" disabled={disabled} onClick={() => open({ caseId: JOURNEY_GENERATE_REQUEST })}><Sparkles />Regenerate</Button>
      </div>
      <CollapsibleContent className="pt-2"><StepList label={`Other ${stageName} tests`}>{others.map(row)}</StepList></CollapsibleContent>
    </Collapsible>}
  </>;
}
