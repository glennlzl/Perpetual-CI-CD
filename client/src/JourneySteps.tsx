import { Ban, Check, Circle, CircleAlert, CircleHelp, CircleX, Clock3, LoaderCircle, SkipForward, type LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { browserBlockers, browserRunLabel, journeySegments, journeyStreaming, type CaseResult, type JourneyStepView } from '@/lib/browser-test-ui';
import { StepItem, StepList } from './StepList';

const ICONS: Record<string, LucideIcon> = { completed: Check, passed: Check, failed: CircleX, blocked: Ban, unconfirmed: CircleHelp, needs_review: CircleAlert, queued: Clock3, skipped: SkipForward };

export function JourneyMark({ status }: { status: string | undefined }) {
  const Icon = journeyStreaming(status) ? LoaderCircle : ICONS[status ?? ''] || Circle;
  return <Icon aria-hidden="true" className={`size-3.5 shrink-0 ${journeyStreaming(status) ? 'motion-safe:animate-spin' : ''} ${status === 'failed' ? 'text-destructive' : ''}`} />;
}

// Segments fill only when a milestone completed with its reviewed checks; the journey's verdict still decides a pass.
export function JourneySegments({ steps, className = '' }: { steps: Parameters<typeof journeySegments>[0]; className?: string }) {
  const segments = journeySegments(steps), observed = segments.filter(item => item.state === 'observed').length;
  if (!segments.length) return null;
  return <div role="img" aria-label={`${observed} of ${segments.length} milestones observed`} className={`journey-segments ${className}`}>{segments.map(item => <span key={item.id} data-state={item.state} title={item.title} />)}</div>;
}

export function JourneyBlockers({ result, steps }: { result: CaseResult | null | undefined; steps: JourneyStepView[] }) {
  const blockers = browserBlockers(result, steps);
  if (!blockers.length) return null;
  return <ul className="space-y-2" aria-label="Blockers">{blockers.map((item, index) => <li key={index} className="space-y-1 text-xs">
    <div className="flex flex-wrap items-center gap-1.5"><Badge variant="outline"><Ban aria-hidden="true" />{item.kind}</Badge>{item.step && <span className="min-w-0 break-words font-medium">{item.step}</span>}</div>
    {item.evidence && <p className="break-words leading-5 text-muted-foreground">{item.evidence}</p>}
  </li>)}</ul>;
}

export default function JourneySteps({ steps, name, className }: { steps: JourneyStepView[]; name: string; className?: string }) {
  if (!steps.length) return null;
  return <StepList label={`${name} milestones`} className={className}>{steps.map(step => <StepItem key={step.id} compact icon={<JourneyMark status={step.status} />}>
    <div className="flex min-h-6 items-start justify-between gap-2 text-xs">
      <span className={`min-w-0 break-words leading-5 ${step.status === 'running' ? 'font-medium' : ['completed', 'failed', 'blocked'].includes(step.status) ? '' : 'text-muted-foreground'}`}>{step.title}</span>
      {step.status !== 'pending' && <span className={`shrink-0 text-xs leading-5 ${step.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>{step.status === 'completed' ? 'Observed' : browserRunLabel(step.status)}</span>}
    </div>
    {step.evidence && <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">{step.evidence}</p>}
    {!!step.checks.length && <ul className="mt-1.5 space-y-1" aria-label={`${step.title} checks`}>{step.checks.map((check, index) => <li key={index} className="flex items-start gap-2 text-xs leading-5">
      <span className="min-w-0 flex-1 break-words tabular-nums">{check.text}{check.error && <span className="block text-destructive">{check.error}</span>}</span>
      {check.passed === undefined ? <span className="shrink-0 text-xs text-muted-foreground">{check.result}</span> : <Badge variant={check.passed ? 'outline' : 'destructive'} className="shrink-0">{check.result}</Badge>}
    </li>)}</ul>}
  </StepItem>)}</StepList>;
}
