import { Item, ItemContent, ItemGroup, ItemMedia } from '@/components/ui/item';
import { Separator } from '@/components/ui/separator';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

// App layout composed from official shadcn primitives, not a separate Timeline component.
export function StepList({ children, label, className }: { children?: ReactNode; label?: string; className?: string }) {
  return <ItemGroup aria-label={label} className={cn('min-w-0', className)}>{children}</ItemGroup>;
}

export function StepItem({ children, icon, compact = false, className }: { children?: ReactNode; icon: ReactNode; compact?: boolean; className?: string }) {
  return <Item role="listitem" size="sm" className={cn(
    'relative flex-nowrap items-start gap-3 rounded-none border-0 p-0 pb-3 last:pb-0 [&:last-child>[data-slot=separator]]:hidden',
    compact && 'gap-2 pb-2', className,
  )}>
    <Separator orientation="vertical" className={cn(
      'pointer-events-none absolute left-4 top-4 data-[orientation=vertical]:h-full',
      compact && 'left-3 top-3',
    )} />
    <ItemMedia variant="icon" aria-hidden="true" className={cn('relative z-10 rounded-full bg-card text-muted-foreground', compact && 'size-6')}>
      {icon}
    </ItemMedia>
    <ItemContent className="min-w-0 gap-0">{children}</ItemContent>
  </Item>;
}
