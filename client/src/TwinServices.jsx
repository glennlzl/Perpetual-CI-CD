import { useEffect, useState, useSyncExternalStore } from 'react';
import { ChevronDown, LoaderCircle, LockKeyhole } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from '@/components/ui/item';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { twinInputsChanges, twinInputsRequest, twinServiceRows } from '@/lib/twin-services';

// The services in a Sandbox stage's twin config; nothing shows when it has none.
// A service blocked on inputs the user supplies connects them in place.
export default function TwinServices({ repoPath, scannedAt, stageId, environment }) {
  const revision = useSyncExternalStore(twinInputsChanges.subscribe, twinInputsChanges.revision);
  const key = JSON.stringify([repoPath, scannedAt, stageId]);
  const [view, setView] = useState(null);
  const [connecting, setConnecting] = useState(null);
  useEffect(() => {
    if (!repoPath || !stageId) return undefined;
    const controller = new AbortController();
    api(`/api/twin/services?${new URLSearchParams({ repoPath, stageId })}`, undefined, { signal: controller.signal }).then(
      result => setView({ key, services: result.services, error: '' }),
      failure => { if (failure.name !== 'AbortError') setView({ key, services: [], error: failure.message }); });
    return () => controller.abort();
  }, [key, revision]);
  // A previous source's rows never show while the current one loads.
  const current = view?.key === key ? view : null;
  if (!current || (!current.error && !current.services.length)) return null;
  const rows = twinServiceRows(current.services, environment);
  const blocked = rows.filter(row => row.status === 'blocked').length;
  return <Collapsible defaultOpen={false} className="nodrag nopan min-w-0">
    <CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="h-8 justify-start gap-2 px-1 text-xs [&[data-state=open]>svg]:rotate-180">
      Services{!current.error && <Badge variant="secondary">{rows.length}</Badge>}{blocked > 0 && <Badge variant="outline"><LockKeyhole aria-hidden="true" />{blocked}<span className="sr-only"> blocked</span></Badge>}<ChevronDown className="size-3.5 text-muted-foreground transition-transform" />
    </Button></CollapsibleTrigger>
    <CollapsibleContent className="pt-1">
      {current.error ? <p role="alert" className="break-words px-1 text-xs text-destructive">{current.error}</p>
        : <ItemGroup aria-label="Services">{rows.map(row => <Item key={row.id} role="listitem" size="sm" className="flex-nowrap gap-2 px-1 py-1.5">
          <ItemContent className="min-w-0"><ItemTitle className="flex-wrap gap-1.5 break-words">{row.title}<Badge variant="outline" className="text-[10px]">{row.fidelityLabel}</Badge>{row.sourceLabel && <Badge variant="outline" className="text-[10px]">{row.sourceLabel}</Badge>}</ItemTitle></ItemContent>
          <ItemActions className="shrink-0 gap-1.5">
            {row.status === 'blocked' && row.missing.length > 0 && <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => setConnecting(row)}>Connect</Button>}
            <Badge variant="secondary">{row.statusLabel}</Badge>
          </ItemActions>
        </Item>)}</ItemGroup>}
    </CollapsibleContent>
    {connecting && <ConnectDialog service={connecting} onClose={() => setConnecting(null)} onSaved={() => { setConnecting(null); twinInputsChanges.notify(); }} />}
  </Collapsible>;
}

function ConnectDialog({ service, onClose, onSaved }) {
  const [values, setValues] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const request = twinInputsRequest(service, values);
  async function save(event) {
    event.preventDefault();
    if (saving || !request) return;
    setSaving(true); setError('');
    try { await api('/api/twin/inputs', request, { method: 'PUT' }); onSaved(); }
    catch (failure) { setError(failure.message); setSaving(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !saving) onClose(); }}><DialogContent aria-describedby={undefined} showCloseButton={!saving} className="sm:max-w-md">
    <DialogHeader><DialogTitle>{service.title}</DialogTitle></DialogHeader>
    <form onSubmit={save} autoComplete="off" className="space-y-4">
      <fieldset disabled={saving} className="space-y-4">
        {service.missing.map(input => {
          const id = `twin-${service.id}-${input.name}`;
          return <div key={input.name} className="grid min-w-0 gap-2">
            <Label htmlFor={id}>{input.label}</Label>
            <Input id={id} type={input.secret ? 'password' : 'text'} autoComplete={input.secret ? 'new-password' : 'off'} autoCapitalize="none" spellCheck={false} required value={values[input.name] ?? ''} aria-invalid={Boolean(error) || undefined}
              onChange={event => { const value = event.target.value; setValues(previous => ({ ...previous, [input.name]: value })); setError(''); }} />
          </div>;
        })}
      </fieldset>
      {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
      <DialogFooter><Button type="button" variant="outline" disabled={saving} onClick={onClose}>Cancel</Button><Button type="submit" disabled={saving || !request}>{saving && <LoaderCircle className="motion-safe:animate-spin" />}Save</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}
