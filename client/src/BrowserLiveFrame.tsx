import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { LoaderCircle, Monitor } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { browserFrameLabel, journeyActive, journeyStreaming } from '@/lib/browser-test-ui';
import { frameIdentity, sharedFrameStore, type FrameSnapshot, type FrameSource } from '@/lib/frame-store';

type FrameRequest = FrameSource & { status: string; revision?: string; interval?: number };
type BrowserLiveFrameProps = {
  repoPath: string; stageId: string; runId: string; caseId: string; name?: string; status: string; updatedAt?: string; revision?: string;
  variant?: 'full' | 'focus' | 'compact'; collapseEmpty?: boolean; onOpen?: () => void; className?: string;
};

const NONE: FrameSnapshot = { identity: '', url: '', error: '', receivedAt: 0, checkedAt: 0 };

// Every viewport of a journey reads one shared, identity-scoped frame loop. Status and
// revision reach an existing loop through update(), not a resubscription.
export function useJourneyFrame({ repoPath, stageId, runId, caseId, status, revision, interval = 350 }: FrameRequest): FrameSnapshot {
  const identity = frameIdentity({ repoPath, stageId, runId, caseId });
  const source = useMemo(() => ({ repoPath, stageId, runId, caseId }), [identity]);
  const enabled = Boolean(runId && caseId);
  const subscribe = useCallback((listener: () => void) => enabled ? sharedFrameStore().subscribe(source, listener, { interval, status, revision }) : () => {}, [source, enabled, interval]);
  const snapshot = useSyncExternalStore(subscribe, () => enabled ? sharedFrameStore().getSnapshot(source) : NONE);
  useEffect(() => { if (enabled) sharedFrameStore().update(source, { status, revision }); }, [source, enabled, status, revision]);
  return snapshot.identity === identity ? snapshot : NONE;
}

export default function BrowserLiveFrame({ repoPath, stageId, runId, caseId, name = 'Journey', status, updatedAt, revision, variant = 'full', collapseEmpty = false, onOpen, className = '' }: BrowserLiveFrameProps) {
  const streaming = journeyStreaming(status);
  const frame = useJourneyFrame({ repoPath, stageId, runId, caseId, status, revision, interval: variant === 'compact' ? 1000 : 350 });
  const fresh = Boolean(updatedAt && frame.checkedAt - new Date(updatedAt).getTime() < 4000);
  const label = browserFrameLabel({ image: Boolean(frame.url), streaming, error: frame.error, fresh, status, runId });
  if (collapseEmpty && !frame.url && !journeyActive(status)) return null;
  const live = streaming || label === 'Reconnecting';
  const image = frame.url && <img src={frame.url} alt={streaming ? `${name} live browser` : `${name} last browser frame`} className="h-full w-full object-contain" />;
  const placeholder = !frame.url && <div className="flex items-center gap-2 text-xs text-muted-foreground">{streaming ? <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" /> : <Monitor aria-hidden="true" className="size-4" />}<span role={live ? 'status' : undefined}>{label}</span></div>;
  const badge = frame.url && <Badge variant="secondary" className={`absolute left-2 bottom-2 ${variant === 'compact' ? 'px-1.5' : ''}`}>{label === 'Live' && <span aria-hidden="true" className="size-1.5 rounded-full bg-current motion-safe:animate-pulse" />}<span role={live ? 'status' : undefined}>{label}</span></Badge>;
  if (variant === 'compact') {
    const content = <>{image}{placeholder}{badge}</>;
    return onOpen
      ? <Button type="button" variant="outline" className={`journey-thumb nodrag nopan h-auto p-0 font-normal ${className}`} aria-label={`Watch ${name}`} onClick={onOpen}>{content}</Button>
      : <div className={`journey-thumb ${className}`} role="img" aria-label={`${name} browser`}>{content}</div>;
  }
  return <div role="group" aria-label={`${name} browser`} className={`journey-browser relative flex min-w-0 items-center justify-center overflow-hidden bg-background ${variant === 'focus' ? 'h-full w-full' : 'aspect-video border-y'} ${className}`}>
    {image}{placeholder}{badge}
  </div>;
}
