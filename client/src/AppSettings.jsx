import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ExternalLink, Eye, EyeOff, LoaderCircle, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';

const openRouter = capabilities => capabilities?.provider === 'openrouter';
const providerNames = { openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', 'meta-llama': 'Meta', 'x-ai': 'xAI', qwen: 'Qwen', mistralai: 'Mistral', nvidia: 'NVIDIA', openrouter: 'OpenRouter', rekaai: 'Reka' };
const namePrefix = name => /^([^:]{1,48}):\s+\S/.exec(name)?.[1].trim();
// Groups are named as the catalog names its models ("Meta: Llama 4"), so slugs that share
// a vendor merge; the slug is only a fallback for a provider whose names carry no prefix.
function modelGroups(models, pinnedId) {
  const prefixes = new Map();
  for (const item of models) {
    const prefix = namePrefix(item.name);
    if (!prefix) continue;
    const counts = prefixes.get(item.provider) || new Map();
    counts.set(prefix, (counts.get(prefix) || 0) + 1);
    prefixes.set(item.provider, counts);
  }
  const labelFor = provider => {
    const counts = prefixes.get(provider);
    if (counts) return [...counts].reduce((best, entry) => entry[1] > best[1] ? entry : best)[0];
    return providerNames[provider] || String(provider).split(/[-_.]+/).filter(Boolean).map(part => part[0].toUpperCase() + part.slice(1)).join(' ');
  };
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  const groups = new Map();
  for (const item of models) {
    if (item.id === pinnedId) continue;
    const label = labelFor(item.provider);
    const key = label.toLocaleLowerCase();
    if (!groups.has(key)) groups.set(key, { label, models: [] });
    groups.get(key).models.push(item);
  }
  return [...groups.values()].sort((a, b) => collator.compare(a.label, b.label))
    .map(group => ({ ...group, models: group.models.sort((a, b) => collator.compare(a.name, b.name) || a.id.localeCompare(b.id)) }));
}
// Inside its group a model drops the repeated vendor prefix; typeahead still matches the full name.
const modelOption = (item, group) => {
  const prefix = namePrefix(item.name);
  const text = group && prefix?.toLocaleLowerCase() === group.toLocaleLowerCase() ? item.name.slice(item.name.indexOf(':') + 1).trim() : item.name;
  return <SelectItem value={item.id} key={item.id} textValue={item.name}><span className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">{text}</span></SelectItem>;
};

// The pinned model stays visible while the catalog scrolls; keyboard focus scrolls items clear of it.
function PinnedGroup({ label, children }) {
  const ref = useCallback(group => {
    const viewport = group?.parentElement;
    if (!viewport) return;
    const sync = () => { viewport.style.scrollPaddingTop = `${group.offsetHeight}px`; };
    const observer = new ResizeObserver(sync);
    observer.observe(group);
    sync();
    return () => { observer.disconnect(); viewport.style.scrollPaddingTop = ''; };
  }, []);
  return <SelectGroup ref={ref} className="sticky top-0 z-10 flow-root bg-popover"><SelectLabel>{label}</SelectLabel>{children}</SelectGroup>;
}

export default function AppSettings({ draft, onDraftChange }) {
  const [capabilities, setCapabilities] = useState(null);
  const [models, setModels] = useState([]);
  const [savedModel, setSavedModel] = useState('');
  const [serverModel, setServerModel] = useState('');
  const model = draft?.model ?? savedModel;
  const apiKey = draft?.apiKey ?? '';
  const [showKey, setShowKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [saving, setSaving] = useState(false);
  const dirty = Boolean(draft);
  // An automatically chosen default is savable but is not an unsaved user edit.
  const suggested = !dirty && Boolean(savedModel) && savedModel !== serverModel;
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(true);
  const loadingRef = useRef(false);
  const modelsLoadingRef = useRef(false);
  const savingRef = useRef(false);
  const hasSavedKey = openRouter(capabilities) && capabilities.keyConfigured;
  const selectedModel = models.find(item => item.id === model);
  const validModel = Boolean(selectedModel);
  // The saved model, or the preselected default, stays pinned above the provider groups.
  const pinnedModel = models.find(item => item.id === savedModel);
  const groups = useMemo(() => modelGroups(models, pinnedModel?.id), [models, pinnedModel]);

  function acceptCatalog(catalog, preferred = '') {
    setModels(catalog.models);
    const selected = catalog.models.some(item => item.id === preferred) ? preferred : catalog.defaultModel;
    setSavedModel(selected || '');
  }
  async function load() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true); setError(''); setModelsError('');
    const [settings, catalog] = await Promise.allSettled([api('/api/settings/model'), api('/api/settings/models')]);
    loadingRef.current = false;
    if (!active.current) return;
    let preferred = '';
    if (settings.status === 'fulfilled') {
      const next = settings.value.capabilities;
      setCapabilities(next);
      preferred = openRouter(next) ? next.model : '';
      setServerModel(preferred);
    } else setError(settings.reason.message);
    if (catalog.status === 'fulfilled') acceptCatalog(catalog.value, preferred);
    else { setSavedModel(preferred); setModelsError(catalog.reason.message); }
    setLoading(false);
  }
  async function reloadModels() {
    if (modelsLoadingRef.current) return;
    modelsLoadingRef.current = true; setModelsLoading(true); setModelsError('');
    try {
      const catalog = await api('/api/settings/models');
      if (active.current) acceptCatalog(catalog, model);
    } catch (failure) { if (active.current) setModelsError(failure.message); }
    finally { modelsLoadingRef.current = false; if (active.current) setModelsLoading(false); }
  }
  useEffect(() => { active.current = true; void load(); return () => { active.current = false; }; }, []);
  function changed(values) {
    onDraftChange({ model, apiKey, ...values });
    setSaved(false);
  }
  async function save(event) {
    event.preventDefault();
    if (savingRef.current || !validModel || !capabilities) return;
    const submittedDraft = draft;
    savingRef.current = true; setSaving(true); setError(''); setSaved(false);
    try {
      const { capabilities: next } = await api('/api/settings/model', { model, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
      // A completed save may outlive this page; retain any newer edits.
      onDraftChange(current => current === submittedDraft ? null : current);
      if (!active.current) return;
      setCapabilities(next); setSavedModel(next.model); setServerModel(next.model); setShowKey(false); setSaved(true);
    } catch (failure) { if (active.current) setError(failure.message); }
    finally { savingRef.current = false; if (active.current) setSaving(false); }
  }

  return <main className="app-settings min-h-0 flex-1 overflow-y-auto px-6 py-10 sm:px-10 lg:py-14" id="settings">
    <section className="mx-auto w-full max-w-2xl" aria-labelledby="openrouter-heading">
      <header className="flex flex-wrap items-center justify-between gap-4 pb-8">
        <div className="flex items-center gap-3"><img src="/assets/providers/openrouter.svg" alt="" width={28} height={28} className="size-7 dark:invert" /><h1 id="openrouter-heading" className="text-xl font-semibold tracking-tight">OpenRouter</h1></div>
        <Button variant="outline" size="sm" asChild><a href="https://openrouter.ai/settings/keys" target="_blank" rel="noopener noreferrer">Get API Key<ExternalLink /></a></Button>
      </header>
      <Separator />
      {loading ? <div role="status" aria-label="Loading settings" className="divide-y">
        {[0, 1].map(row => <div key={row} className="grid gap-3 py-7 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-8" aria-hidden="true"><Skeleton className="h-4 w-28 sm:mt-3" /><Skeleton className="h-10 w-full" /></div>)}
      </div> : <form onSubmit={save}>
        <fieldset disabled={saving || !capabilities} className="m-0 min-w-0 border-0 p-0">
          <div className="grid gap-3 py-7 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-8">
            {/* The stored key is never returned, so its state is named beside the label. */}
            <div className="flex flex-wrap items-center gap-2 sm:flex-col sm:items-start sm:self-start sm:pt-3">
              <Label htmlFor="openrouter-api-key">OpenRouter API Key</Label>
              {capabilities && <Badge id="openrouter-api-key-state" variant={hasSavedKey ? 'secondary' : 'outline'}>{hasSavedKey ? 'Saved' : 'Not set'}</Badge>}
            </div>
            <div className="relative min-w-0"><Input id="openrouter-api-key" type={showKey ? 'text' : 'password'} autoComplete="new-password" autoCapitalize="none" spellCheck={false} required={!hasSavedKey} aria-describedby={capabilities ? 'openrouter-api-key-state' : undefined} placeholder={hasSavedKey ? '••••••••••••••••••••••••' : 'sk-or-v1-…'} value={apiKey} maxLength={4096} className="h-10 pr-11" onChange={event => { changed({ apiKey: event.target.value }); }} /><Button type="button" variant="ghost" size="icon-sm" className="absolute top-1 right-1" disabled={!apiKey || saving} aria-label={showKey ? 'Hide API key' : 'Show API key'} aria-pressed={showKey} onClick={() => setShowKey(value => !value)}>{showKey ? <EyeOff /> : <Eye />}</Button></div>
          </div>
          <Separator />
          <div className="grid gap-3 py-7 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-8">
            <Label htmlFor="openrouter-model" className="sm:self-start sm:pt-3">Model</Label>
            <div className="min-w-0 space-y-3">
              <Select value={validModel ? model : ''} disabled={saving || modelsLoading || !models.length || !capabilities} onValueChange={value => { changed({ model: value }); }}>
                <SelectTrigger id="openrouter-model" className="min-w-0 w-full data-[size=default]:h-10" title={selectedModel?.name}><span className="min-w-0 flex-1 truncate text-left"><SelectValue placeholder={modelsLoading ? 'Loading models…' : 'Select a model'}>{selectedModel?.name}</SelectValue></span></SelectTrigger>
                <SelectContent position="popper" align="start" collisionPadding={16} className="max-h-[min(60dvh,var(--radix-select-content-available-height))] w-(--radix-select-trigger-width) max-w-[calc(100vw-2rem)]">{pinnedModel && <PinnedGroup label={savedModel === serverModel ? 'Current' : 'Default'}>{modelOption(pinnedModel)}{groups.length > 0 && <SelectSeparator />}</PinnedGroup>}{groups.map(group => <SelectGroup key={group.label}><SelectLabel>{group.label}</SelectLabel>{group.models.map(item => modelOption(item, group.label))}</SelectGroup>)}</SelectContent>
              </Select>
              {modelsError && <div className="space-y-2"><p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">{modelsError}</p><Button type="button" variant="outline" size="sm" disabled={modelsLoading || saving} onClick={reloadModels}><RefreshCw className={modelsLoading ? 'motion-safe:animate-spin' : ''} />Reload models</Button></div>}
            </div>
          </div>
        </fieldset>
        <Separator />
        <footer className="flex items-center justify-end gap-3 py-6">{dirty && <Button type="button" variant="ghost" disabled={saving} onClick={() => { onDraftChange(null); setShowKey(false); }}>Discard changes</Button>}{saved && <span role="status" className="flex items-center gap-1.5 text-sm text-muted-foreground"><Check className="size-4" />Saved</span>}{!capabilities ? <Button type="button" variant="outline" onClick={load}>Try again</Button> : <Button type="submit" disabled={saving || modelsLoading || !(dirty || suggested) || !validModel || (!apiKey.trim() && !hasSavedKey)}>{saving && <LoaderCircle className="motion-safe:animate-spin" />}{saving ? 'Saving…' : 'Save changes'}</Button>}</footer>
      </form>}
      {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
    </section>
  </main>;
}
