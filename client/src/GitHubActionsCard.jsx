import { Fragment, useEffect, useState } from 'react';
import { ChevronDown, CircleCheck, CircleDashed, CircleMinus, CircleSlash, CircleX, ListChecks, LoaderCircle, RotateCw, Terminal, Workflow } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { GITHUB_MARK_LABELS, actionLabel, actionText, jobMark, jobRuns, stepMark, workflowMark, workflowRuns } from '@/lib/pipeline-github.mjs';
import { useRememberedOpen } from '@/lib/remembered-open';
import { StepItem, StepList } from './StepList';

const MARKS = { queued: CircleDashed, waiting: CircleDashed, passed: CircleCheck, failed: CircleX, cancelled: CircleSlash, skipped: CircleMinus };
const withMark = (label, mark) => mark ? `${label}, ${GITHUB_MARK_LABELS[mark]}` : label;

// Current-commit run status on the configured rail; unmatched rows keep their icon.
function RunMark({ mark, fallback }) {
  if (!mark) return fallback;
  if (mark === 'running') return <LoaderCircle className="size-3.5 text-foreground motion-safe:animate-spin" />;
  const Mark = MARKS[mark];
  return <Mark className={`size-3.5${mark === 'failed' ? ' text-destructive' : mark === 'passed' ? ' text-foreground' : ''}`} />;
}

// Short action refs and expression contexts; the title keeps the scanned text.
// Labels wrap at max-w-64 rather than widening the stage card.
function ActionName({ value, fallback }) {
  const { text, ref, contexts } = actionLabel(value, fallback);
  return <>{text}{ref && <>{' '}<span className="font-mono text-muted-foreground">{ref}</span></>}{contexts.map(context => <Fragment key={context}>{' '}<Badge variant="outline" className="px-1.5 py-0 font-mono font-normal">{context}</Badge></Fragment>)}</>;
}

function ActionGroup({ openKey, name, fallback, label, children }) {
  const [open, setOpen] = useRememberedOpen(openKey);
  return <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
    <CollapsibleTrigger asChild>
      <Button type="button" variant="ghost" size="sm" className="h-auto min-h-6 min-w-0 w-full items-start justify-between gap-2 whitespace-normal px-1 py-0.5 text-left leading-5 [&[data-state=open]>svg]:rotate-180" aria-label={label} title={name}>
        <span className="min-w-0 max-w-64 flex-1 [overflow-wrap:anywhere]"><ActionName value={name} fallback={fallback} /></span><ChevronDown className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform" />
      </Button>
    </CollapsibleTrigger>
    <CollapsibleContent className="pt-1">{children}</CollapsibleContent>
  </Collapsible>;
}

function ActionsLoading() {
  return <div role="status" aria-label="Loading actions…"><div aria-hidden="true">
    <StepList>
      {['w-32', 'w-40', 'w-28'].map(width => <StepItem key={width} compact icon={<Skeleton className="size-3 rounded-full" />}>
        <div className="flex min-h-6 min-w-0 items-center justify-between gap-2 px-1">
          <Skeleton className={`h-3 max-w-full ${width}`} /><Skeleton className="size-3 shrink-0" />
        </div>
      </StepItem>)}
    </StepList>
  </div></div>;
}

export default function GitHubActionsCard({ repoPath, scannedAt, runs = null }) {
  const [workflows, setWorkflows] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const openKey = `github-actions:${repoPath}`;
  const [open, setOpen] = useRememberedOpen(openKey);

  useEffect(() => {
    let active = true;
    setWorkflows([]);
    setError('');
    setLoading(true);
    const params = new URLSearchParams({ repoPath });
    api(`/api/github-actions?${params}`).then(result => {
      if (active) setWorkflows(result.workflows);
    }).catch(failure => {
      if (active) setError(failure instanceof Error ? failure.message : 'Could not load actions.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [repoPath, scannedAt, reload]);

  return <Collapsible open={open} onOpenChange={setOpen} className="nodrag nopan min-w-0">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="h-auto min-h-8 min-w-0 w-full items-start justify-between gap-2 whitespace-normal px-1 py-1 text-left leading-6 [&[data-state=open]>svg]:rotate-180" aria-label="GitHub Actions">
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">GitHub</span><ChevronDown className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pb-1">
          {loading ? <ActionsLoading />
            : error ? <div className="space-y-2 p-2"><p role="alert" className="break-words text-xs text-destructive">{error}</p><Button type="button" variant="outline" size="sm" onClick={() => setReload(value => value + 1)}><RotateCw />Retry</Button></div>
            : workflows.length ? <StepList label="GitHub workflows">
              {workflows.map(workflow => {
                const matched = workflowRuns(runs, workflow.file), mark = workflowMark(runs, workflow.file), file = workflow.file.split('/').at(-1), workflowName = actionText(workflow.name, file);
                return <StepItem key={`${scannedAt}:${workflow.file}`} compact icon={<RunMark mark={mark} fallback={<Workflow className="size-3.5" />} />}>
                  <ActionGroup openKey={`${openKey}:${workflow.file}`} name={workflow.name} fallback={file} label={withMark(`Workflow: ${workflowName}`, mark)}>
                    {workflow.error && <p role="alert" className="break-words px-2 py-2 text-xs text-destructive">{workflow.error}</p>}
                    {workflow.jobs.length ? <StepList label={`${workflowName} jobs`}>
                      {workflow.jobs.map(job => {
                        const jobs = jobRuns(matched, job), jobState = jobMark(matched, job), jobName = actionText(job.name, job.id);
                        return <StepItem key={job.id} compact icon={<RunMark mark={jobState} fallback={<ListChecks className="size-3.5" />} />}>
                          <ActionGroup openKey={`${openKey}:${workflow.file}:${job.id}`} name={job.name} fallback={job.id} label={withMark(`Job: ${jobName}`, jobState)}>
                            {job.steps.length ? <StepList label={`${jobName} steps`}>
                              {job.steps.map((step, index) => {
                                const stepState = stepMark(jobs, step);
                                return <StepItem key={`${index}:${step.id}`} compact icon={<RunMark mark={stepState} fallback={<Terminal className="size-3.5" />} />}>
                                  <p className="min-w-0 max-w-[16.5rem] px-1 text-xs leading-6 text-muted-foreground [overflow-wrap:anywhere]" title={step.name}><ActionName value={step.name} fallback="Step" />{stepState && <span className="sr-only">, {GITHUB_MARK_LABELS[stepState]}</span>}</p>
                                </StepItem>;
                              })}
                            </StepList> : <p className="px-2 py-2 text-xs text-muted-foreground">No steps</p>}
                          </ActionGroup>
                        </StepItem>;
                      })}
                    </StepList> : !workflow.error && <p className="px-2 py-2 text-xs text-muted-foreground">No jobs</p>}
                  </ActionGroup>
                </StepItem>;
              })}
            </StepList> : <p className="px-2 py-2 text-xs text-muted-foreground">No actions found</p>}
      </CollapsibleContent>
  </Collapsible>;
}
