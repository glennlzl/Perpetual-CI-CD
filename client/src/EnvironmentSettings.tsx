import { useMemo, useState } from 'react';
import { Box, CircleDot, CircleMinus, CircleX, LoaderCircle, X, type LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { inspectorTab } from '@/lib/browser-test-ui';
import { targetSuggestions } from '@/lib/journey-config';
import { environmentWorking } from '@/lib/stage-activity.ts';
import { useSourceBranch, useSourcePreviews, useTestStage } from '@/lib/use-test-workspace';
import BrowserTestingPanel from './BrowserTestingPanel';
import type { Environment } from '@/lib/test-workspace';
import type { PipelineStage } from '@/lib/pipeline-nodes.ts';

const ACTIVE = ['queued', 'creating', 'preparing', 'ready', 'destroying', 'cleanup_failed'];
const STATUS: Record<string, string> = { queued: 'Queued', creating: 'Creating', preparing: 'Preparing', ready: 'Ready', failed: 'Failed', destroying: 'Deleting', destroyed: 'Deleted', cleanup_failed: 'Cleanup failed' };

export const environmentStatusLabel = (status: string | undefined) => (status && STATUS[status]) || status || 'Not provisioned';
export const environmentHasResources = (item: Environment | null | undefined) => Boolean(item && item.status !== 'destroyed' && !(item.status === 'failed' && (!item.sandboxId || item.cleanedAt)));
export function latestEnvironment(environments: Environment[] = [], stageId?: string) {
  const items = environments.filter(item => !stageId || item.stageId === stageId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return items.find(item => ACTIVE.includes(item.status) || environmentHasResources(item)) || items[0] || null;
}
// The header status reads like the stage card's: ready, working, failed, or an absent/idle sandbox.
export function environmentTone(status: string | undefined) {
  if (!status) return 'unconfigured';
  if (status === 'ready') return 'ready';
  if (['failed', 'cleanup_failed'].includes(status)) return 'failed';
  return environmentWorking(status) ? 'working' : 'idle';
}
const TONE_ICONS: Record<string, LucideIcon> = { ready: CircleDot, failed: CircleX, working: LoaderCircle };
function EnvironmentStatus({ status }: { status: string | undefined }) {
  const tone = environmentTone(status), Icon = TONE_ICONS[tone] || CircleMinus;
  const quiet = ['idle', 'unconfigured'].includes(tone);
  return <Badge variant={tone === 'failed' ? 'destructive' : quiet ? 'outline' : 'secondary'} data-tone={tone} className={`shrink-0 ${quiet ? 'text-muted-foreground' : ''}`}>
    <Icon aria-hidden="true" className={tone === 'working' ? 'motion-safe:animate-spin' : undefined} />{environmentStatusLabel(status)}
  </Badge>;
}
export function safeLink(value: unknown) {
  if (typeof value !== 'string' || !value) return null;
  try { const url = new URL(value, window.location.origin); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; }
  catch { return null; }
}

type EnvironmentSettingsProps = {
  repoPath?: string; stage?: PipelineStage; initialTab?: string; initialError?: string; initialWatch?: boolean; initialRunId?: string; initialCaseId?: string; caseRequestKey?: number | string;
  onClose: () => void; onBusyChange?: (busy: boolean) => void; onAppSettings?: () => void; busy?: boolean;
};
export default function EnvironmentSettings({ repoPath, stage, initialTab = 'browser', initialError = '', initialWatch = false, initialRunId = '', initialCaseId = '', caseRequestKey = '', onClose, onBusyChange, onAppSettings, busy = false }: EnvironmentSettingsProps) {
  // Each graph request selects its tab during render, so the panel never handles it against the other view.
  const [tabState, setTabState] = useState(() => inspectorTab(null, initialTab, caseRequestKey));
  const requested = inspectorTab(tabState, initialTab, caseRequestKey);
  if (requested !== tabState) setTabState(requested);
  const tab = requested.tab;
  const validStage = stage?.kind === 'sandbox' && Boolean(repoPath);
  const [, snapshot] = useTestStage(stage?.id, validStage ? ['environment'] : []);
  const previews = useSourcePreviews();
  const branch = useSourceBranch();
  const current = latestEnvironment(snapshot.environment.environments);
  const suggestions = useMemo(() => targetSuggestions({ environment: current, previews, branch }), [current, previews, branch]);
  const disabled = busy || Boolean(snapshot.pending);

  return <>
    <SheetHeader className="flex-row items-center gap-3">
      <Box className="size-6 shrink-0" />
      <SheetTitle className="min-w-0 flex-1 truncate text-xl">{stage?.name || 'Sandbox'}</SheetTitle>
      {(current || !snapshot.loading.environment) && <EnvironmentStatus status={current?.status} />}
      <Button variant="ghost" size="icon" disabled={disabled} aria-label="Close" onClick={onClose}><X /></Button>
    </SheetHeader>
    <Tabs value={tab} onValueChange={value => setTabState({ ...requested, tab: value })} className="min-h-0 min-w-0 flex-1 gap-0">
      <TabsList variant="line" className="mx-4 w-auto shrink-0 justify-start group-data-[orientation=horizontal]/tabs:h-auto" aria-label="Test views">
        <TabsTrigger value="browser" className="h-9 flex-none">Integration tests</TabsTrigger>
        <TabsTrigger value="browser-runs" className="h-9 flex-none">Runs</TabsTrigger>
      </TabsList>
      <div className="inspector-body min-h-0 flex-1 overflow-y-auto p-4">
        {!validStage ? <p role="alert" className="break-words text-sm text-destructive">Choose a Sandbox stage.</p> : <TabsContent value={tab} forceMount className="rounded-md focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <BrowserTestingPanel
            repoPath={repoPath!}
            stageId={stage.id}
            busy={disabled}
            view={tab === 'browser-runs' ? 'runs' : 'tests'}
            environmentStatus={current?.status}
            targetSuggestions={suggestions}
            environmentError={initialError}
            initialRunId={initialWatch ? initialRunId : ''}
            initialWatch={initialWatch}
            initialCaseId={initialCaseId}
            caseRequestKey={caseRequestKey}
            onAppSettings={onAppSettings}
            onBusyChange={onBusyChange}
          />
        </TabsContent>}
      </div>
    </Tabs>
  </>;
}
