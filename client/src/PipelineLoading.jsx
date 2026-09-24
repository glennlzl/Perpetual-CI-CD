import { BaseNode, BaseNodeHeader } from '@/components/base-node';
import { Skeleton } from '@/components/ui/skeleton';
import { INITIAL_PIPELINE_VIEWPORT } from '@/lib/pipeline-viewport.mjs';

// Placeholder stages sit where the canvas first draws the real ones: in one row,
// at the entry framing, so the pipeline replaces them without shifting.
const { x, y, zoom } = INITIAL_PIPELINE_VIEWPORT;
const FRAME = { transform: `translate(${x}px, ${y}px) scale(${zoom})` };
const STAGES = [1, 3, 1, 0];

export default function PipelineLoading() {
  return <section className="pipeline-canvas" role="status" aria-label="Loading pipeline" aria-busy="true">
    <div className="pipeline-branch-toolbar" aria-hidden="true">
      <Skeleton className="h-11 w-64 min-w-0 shrink" />
      <Skeleton className="size-11 shrink-0" />
      <Skeleton className="h-11 w-28 shrink-0" />
    </div>
    <div className="flow-viewport overflow-hidden" aria-hidden="true">
      <div className="pipeline-loading-frame" style={FRAME}>
        {STAGES.map((rows, index) => <BaseNode key={index} className="pipeline-stage" data-expanded={rows > 0} tabIndex={-1}>
          <BaseNodeHeader className="stage-header"><Skeleton className="h-5 w-28" /><Skeleton className="h-5 w-16 rounded-full" /></BaseNodeHeader>
          {rows > 0 && <div className="stage-actions flex flex-col gap-3">
            {Array.from({ length: rows }, (_, row) => <div key={row} className="flex items-center gap-3"><Skeleton className="size-8 shrink-0 rounded-full" /><Skeleton className="h-4 w-40" /></div>)}
          </div>}
        </BaseNode>)}
      </div>
    </div>
  </section>;
}
