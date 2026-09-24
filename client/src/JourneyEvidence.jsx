import { Badge } from '@/components/ui/badge';
import { CHECKS, OUTCOMES, browserActionFailure, browserActionLabel, browserRunLabel, checkedOutcome, journeyActions, journeyCheckState } from '@/lib/browser-test-ui';
import { JourneyMark } from './JourneySteps';

export const hasJourneyEvidence = (result, progress) => Boolean(result?.engine || result?.outcomes?.length || result?.assertions?.length || journeyActions(progress).items.length);

// Agent observations, final independent checks and browser actions stay visibly separate.
export default function JourneyEvidence({ item, result, progress }) {
  const { items: actions, count } = journeyActions(progress);
  if (!hasJourneyEvidence(result, progress)) return null;
  const checked = result?.engine === 'playwright' && checkedOutcome(result);
  return <div className="space-y-4">
    {checked && <section className="space-y-2"><div className="flex items-center justify-between gap-2"><h4 className="text-xs font-medium text-muted-foreground">Expected outcomes</h4><Badge variant="outline">Playwright</Badge></div><ul className="space-y-3 text-sm">{(item.expectedOutcomes || []).map((outcome, index) => <li key={index} className="space-y-1 break-words"><p className="max-w-[75ch]">{outcome}</p><Badge variant={checked.variant}>{checked.label}</Badge></li>)}</ul></section>}
    {!!result?.outcomes?.length && <section className="space-y-2"><h4 className="text-xs font-medium text-muted-foreground">Expected outcomes</h4><ul className="space-y-3 text-sm">{(item.expectedOutcomes || []).map((outcome, index) => {
      const observation = result.outcomes.find(value => value.outcomeIndex === index);
      return <li key={index} className="space-y-1 break-words"><p className="max-w-[75ch]">{outcome}</p><Badge variant={observation?.status === 'failed' ? 'destructive' : 'outline'}>Agent · {OUTCOMES[observation?.status] || 'Not reported'}</Badge>{observation?.evidence && <p className="max-w-[75ch] text-xs text-muted-foreground">{observation.evidence}</p>}</li>;
    })}</ul></section>}
    {!!result?.assertions?.length && <section className="space-y-2"><h4 className="text-xs font-medium text-muted-foreground">Final checks</h4><ul className="space-y-1.5">{result.assertions.map((check, index) => { const state = journeyCheckState(check); return <li key={index} className="flex items-start gap-2 text-xs leading-5">
      <span className="min-w-0 flex-1 break-words">{CHECKS[check.type] || check.type}: {check.value}</span><Badge variant={state.variant} className="shrink-0">{state.label}</Badge>
    </li>; })}</ul></section>}
    {!!actions.length && <section className="space-y-2"><h4 className="text-xs font-medium text-muted-foreground">Actions ({count})</h4><ol className="space-y-1" aria-label="Browser actions">{actions.map((action, index) => <li key={action.index ?? index} className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <JourneyMark status={action.status} /><span className="text-foreground">{browserActionLabel(action.type)}</span>{browserActionFailure(action) ? <span className="text-destructive">{browserActionFailure(action)}</span> : <span className="sr-only">{browserRunLabel(action.status)}</span>}
    </li>)}</ol></section>}
  </div>;
}
