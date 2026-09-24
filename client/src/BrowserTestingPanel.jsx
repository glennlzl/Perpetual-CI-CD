import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, CircleCheck, CircleX, Code, Copy, ExternalLink, Eye, GitBranch, LoaderCircle, MoreHorizontal, Pencil, Play, Plus, Sparkles, Square, Trash2 } from 'lucide-react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Item, ItemActions, ItemContent, ItemFooter, ItemGroup, ItemMedia, ItemSeparator, ItemTitle } from '@/components/ui/item';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTestStage } from '@/lib/use-test-workspace';
import { browserCaseRun, browserCaseState, browserConcurrencyLabel, browserReadiness, browserRunLabel, browserRunTitle, browserUnavailable, generateRequestDialog, journeyCode, journeyRequest, runEngines, testToolbar } from '@/lib/browser-test-ui';
import { useReturnFocus } from '@/lib/journey-focus';
import { MAX_CASES, branchMismatchNote, defaultReplaceIds, generateError, journeyTimeoutMinutes, sameUrl, validUrl, validateTestSettings } from '@/lib/journey-config';
import { buildJourneySteps, reviewedStepError, stepRow } from '@/lib/journey-steps';
import { oneOffSelection, rememberOneOffRun, restoreSelection, settleOneOffRun } from '@/lib/run-selection';
import { MANUAL, NONE, accountOptions, accountRequest, initialAccount, usesAccount } from '@/lib/test-accounts';
import BrowserAgentViewer from './BrowserAgentViewer';
import JourneyCard from './JourneyCard';
import JourneyStepEditor from './JourneyStepEditor';
import NewTestDialog from './NewTestDialog';

import { caseDraftKey, caseDraftOriginal, caseDrafts, newTestDraftKey, pruneCaseDrafts } from '@/lib/case-drafts';
const ACTIVE = new Set(['queued', 'running']);
const CHECKS = { 'text-visible': 'Text visible', 'text-absent': 'Text absent', 'url-contains': 'URL contains' };
const DEFINITION = ['name', 'goal', 'preconditions', 'expectedOutcomes', 'assertions', 'steps'];
const lines = value => value.split('\n').map(item => item.trim()).filter(Boolean);
const reviewed = item => !item.needsReview && Boolean(item.name?.trim()) && Boolean(item.goal?.trim()) && item.expectedOutcomes?.some(value => value.trim());
const dateLabel = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(); };
let rowKeys = 0;
const rowsOf = values => values.map(value => ({ key: `entry-${++rowKeys}`, value }));
function Field({ id, label, children }) { return <div className="grid min-w-0 gap-2"><Label htmlFor={id}>{label}</Label>{children}</div>; }
function ErrorText({ children }) { return children ? <p role="alert" className="break-words text-sm text-destructive">{children}</p> : null; }
function FieldError({ children }) { return children ? <p className="break-words text-xs text-destructive">{children}</p> : null; }
function TestListSkeleton({ label }) {
  return <div role="status" aria-label={label} className="space-y-2">
    {[0, 1, 2].map(index => <Item key={index} size="sm" variant="outline" aria-hidden="true" className="flex-nowrap items-start gap-3 px-3 py-3">
      <Skeleton className="mt-1 h-4 w-8 shrink-0" />
      <div className="min-w-0 flex-1 space-y-2"><Skeleton className="h-4 w-5/6" /><Skeleton className="h-4 w-24" /></div>
      <Skeleton className="size-6 shrink-0" />
    </Item>)}
  </div>;
}

// A blocked action stays focusable and named (aria-disabled, click guarded), so its Tooltip can list
// every blocker, one per line. The Tooltip stays mounted, so a new blocker never remounts the button.
const STILL = { default: 'aria-disabled:hover:bg-primary', outline: 'aria-disabled:hover:bg-background aria-disabled:hover:text-foreground dark:aria-disabled:hover:bg-input/30' };
function BlockedButton({ reason, onClick, variant = 'default', className = '', ...props }) {
  const [open, setOpen] = useState(false);
  return <Tooltip open={open && Boolean(reason)} onOpenChange={setOpen}>
    <TooltipTrigger asChild><Button {...props} variant={variant} aria-disabled={reason ? true : undefined} className={`aria-disabled:cursor-not-allowed aria-disabled:opacity-50 ${STILL[variant] || ''} ${className}`} onClick={event => { if (reason) event.preventDefault(); else onClick?.(event); }} /></TooltipTrigger>
    {reason && <TooltipContent>{reason.split('\n').map(line => <span key={line} className="block">{line}</span>)}</TooltipContent>}
  </Tooltip>;
}

// In a narrow inspector the three actions fill one row with their labels (equal widths when they fit);
// a label that cannot fit (a selected count on the narrowest phones) takes a full-width row, never a ragged one.
const NARROW_TOOL = '@max-md:flex-1 @max-md:[&>svg]:hidden';

function InstallCommand({ command }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  async function copy() {
    try { await navigator.clipboard.writeText(command); setCopied(true); }
    catch { /* The command stays selectable. */ }
  }
  return <div className="flex w-full min-w-0 items-start gap-2 rounded-md border bg-muted/40 py-1.5 pr-1.5 pl-3">
    {/* Lines wrap at spaces and after each "/", never inside a word; only an overlong segment breaks anywhere. */}
    <pre className="min-w-0 flex-1 select-all whitespace-pre-wrap break-normal py-1 font-mono text-xs leading-5 [overflow-wrap:anywhere]"><code>{command.split('/').map((part, index) => index ? <Fragment key={index}>/<wbr />{part}</Fragment> : part)}</code></pre>
    <Button type="button" variant="ghost" size="icon-sm" className="shrink-0" aria-label="Copy install command" onClick={copy}>{copied ? <Check /> : <Copy />}</Button>
    <span role="status" className="sr-only">{copied ? 'Copied' : ''}</span>
  </div>;
}

// Every Generate/Run prerequisite with its own fix; the panel hides the list once all are met.
function Readiness({ items, primary, targetBlocker, onTarget, onAppSettings }) {
  return <ItemGroup aria-label="Readiness" className="test-readiness rounded-lg border">
    {items.map((item, index) => <Fragment key={item.id}>
      {index > 0 && <ItemSeparator />}
      <Item role="listitem" size="sm" data-ready={item.ready} className="min-h-12 gap-x-3 gap-y-2 px-3 py-2">
        <ItemMedia>{item.ready ? <CircleCheck aria-hidden="true" className="size-4 text-muted-foreground" /> : <CircleX aria-hidden="true" className="size-4" />}</ItemMedia>
        <ItemContent className="min-w-0"><ItemTitle className={item.ready ? 'font-normal text-muted-foreground' : ''}>{item.label}<span className="sr-only">{item.ready ? ': ready' : ': missing'}</span></ItemTitle></ItemContent>
        {!item.ready && item.id === 'target' && <ItemActions><BlockedButton reason={targetBlocker} size="sm" variant={primary === 'target' ? 'default' : 'outline'} onClick={onTarget}>Set target URL</BlockedButton></ItemActions>}
        {!item.ready && item.id === 'model' && <ItemActions><Button size="sm" variant={primary === 'model' ? 'default' : 'outline'} onClick={() => onAppSettings?.()}>Settings</Button></ItemActions>}
        {!item.ready && item.command && <ItemFooter><InstallCommand command={item.command} /></ItemFooter>}
      </Item>
    </Fragment>)}
  </ItemGroup>;
}

// Entered account values stay in this dialog's memory for one request and are never stored.
// A twin's own test accounts are chosen by id; their passwords stay on the controller.
function TestAccountFields({ id, accounts, account, onChange }) {
  const choose = choice => onChange({ ...initialAccount(), choice });
  return <>
    {accounts.length
      ? <Field id={`${id}-test-account`} label="Test account"><Select value={account.choice} onValueChange={choose}><SelectTrigger id={`${id}-test-account`} className="w-full min-w-0"><SelectValue /></SelectTrigger><SelectContent>{accountOptions(accounts).map(option => <SelectItem key={option.value} value={option.value}><span className="min-w-0 truncate">{option.label}</span>{option.detail && <span className="min-w-0 truncate text-muted-foreground">{option.detail}</span>}</SelectItem>)}</SelectContent></Select></Field>
      : <div className="flex items-center justify-between gap-3"><Label htmlFor={`${id}-use-test-account`}>Use test account</Label><Switch id={`${id}-use-test-account`} checked={account.choice === MANUAL} onCheckedChange={checked => choose(checked ? MANUAL : NONE)} /></div>}
    {account.choice === MANUAL && <>
      <Field id={`${id}-test-username`} label="Username"><Input id={`${id}-test-username`} required autoComplete="off" autoCapitalize="none" spellCheck={false} value={account.username} onChange={event => onChange({ ...account, username: event.target.value })} /></Field>
      <Field id={`${id}-test-password`} label="Password"><Input id={`${id}-test-password`} required type="password" autoComplete="new-password" value={account.password} onChange={event => onChange({ ...account, password: event.target.value })} /></Field>
    </>}
  </>;
}

function ListField({ id, label, itemLabel, rows, errors, listError, max, addLabel, showErrors, onChange }) {
  const [added, setAdded] = useState('');
  return <div role="group" aria-labelledby={`${id}-label`} className="grid min-w-0 gap-2">
    <Label id={`${id}-label`}>{label}</Label>
    {rows.map((row, index) => <div key={row.key} className="grid gap-1">
      <div className="flex items-center gap-2">
        <Input aria-label={`${itemLabel} ${index + 1}`} autoFocus={row.key === added} type="url" inputMode="url" autoCapitalize="none" spellCheck={false} maxLength={2048} value={row.value} aria-invalid={Boolean(showErrors && errors[index]) || undefined} className="min-w-0 flex-1" onChange={event => onChange(rows.map(current => current.key === row.key ? { ...current, value: event.target.value } : current))} />
        <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${itemLabel.toLowerCase()} ${index + 1}`} onClick={() => onChange(rows.filter(current => current.key !== row.key))}><Trash2 /></Button>
      </div>
      {showErrors && <FieldError>{errors[index]}</FieldError>}
    </div>)}
    <Button type="button" variant="outline" size="sm" className="w-fit" disabled={rows.length >= max} onClick={() => { const [row] = rowsOf(['']); setAdded(row.key); onChange([...rows, row]); }}><Plus />{addLabel}</Button>
    <FieldError>{listError}</FieldError>
  </div>;
}

// A known branch tags the URL. One deploying another branch than the scanned one keeps its branch mark,
// takes the warning tint (inverted on the filled, chosen chip) and names both branches in its Tooltip.
function KnownUrl({ item, chosen, onChoose }) {
  const branch = item.branches?.join(', ') || '';
  const note = item.mismatch && item.scannedBranch ? branchMismatchNote(item.branches, item.scannedBranch) : '';
  const quiet = chosen ? 'opacity-80' : 'text-muted-foreground';
  const warning = chosen ? 'text-amber-300 dark:text-amber-800' : 'text-(--warning)';
  const chip = <Button type="button" size="sm" variant={chosen ? 'default' : 'outline'} aria-pressed={chosen} title={note ? undefined : item.url} aria-label={`${item.label}: ${item.url}${branch ? `, branch ${branch}` : ''}${item.mismatch ? ', not the scanned branch' : ''}`} className={`h-auto min-h-8 max-w-full min-w-0 flex-wrap justify-start gap-x-1.5 gap-y-0.5 whitespace-normal py-1 text-left font-normal ${chosen ? '' : 'dark:bg-transparent'}`} onClick={onChoose}>
    <span className="font-medium">{item.label}</span><span className={`min-w-0 [overflow-wrap:anywhere] ${quiet}`}>{new URL(item.url).host}</span>
    {branch && <span className={`inline-flex min-w-0 items-center gap-1 text-xs [overflow-wrap:anywhere] ${item.mismatch ? warning : quiet}`}><GitBranch aria-hidden="true" className="size-3" />{branch}</span>}
  </Button>;
  return note ? <Tooltip><TooltipTrigger asChild>{chip}</TooltipTrigger><TooltipContent>{note}</TooltipContent></Tooltip> : chip;
}

function TestSettingsDialog({ config, suggestions = [], onSave, onClose, focusFallback }) {
  const returnFocus = useReturnFocus(focusFallback);
  const [targetUrl, setTargetUrl] = useState(config.targetUrl || '');
  const [origins, setOrigins] = useState(() => rowsOf(config.externalOrigins || []));
  const [endpoints, setEndpoints] = useState(() => rowsOf(config.authEndpoints || []));
  const [minutes, setMinutes] = useState(() => journeyTimeoutMinutes(config));
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const checked = validateTestSettings({ targetUrl, externalOrigins: origins.map(row => row.value), authEndpoints: endpoints.map(row => row.value), timeoutMinutes: minutes });
  const shown = attempted ? checked.errors : {};
  async function submit(event) {
    event.preventDefault();
    if (saving) return;
    setAttempted(true); setError('');
    if (!checked.valid) return;
    setSaving(true);
    try { await onSave({ ...config, ...checked.values }); }
    catch (failure) { setError(failure.message); setSaving(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !saving) onClose(); }}><DialogContent aria-describedby={undefined} showCloseButton={!saving} onCloseAutoFocus={returnFocus}>
    <DialogHeader><DialogTitle>Test settings</DialogTitle></DialogHeader>
    <form onSubmit={submit} noValidate className="space-y-4">
      <fieldset disabled={saving} className="space-y-5">
        <Field id="test-target-url" label="Target URL">
          <Input id="test-target-url" type="url" required maxLength={2048} placeholder="http://localhost:3000" value={targetUrl} aria-invalid={Boolean(shown.targetUrl) || undefined} onChange={event => setTargetUrl(event.target.value)} />
          {suggestions.length > 0 && <div role="group" aria-label="Known URLs" className="flex min-w-0 flex-wrap gap-2">{suggestions.map(item => <KnownUrl key={item.url} item={item} chosen={sameUrl(targetUrl.trim(), item.url)} onChoose={() => setTargetUrl(item.url)} />)}</div>}
          <FieldError>{shown.targetUrl}</FieldError>
        </Field>
        <ListField id="external-origins" label="External sites allowed in runs" itemLabel="Site" addLabel="Add site" max={10} rows={origins} errors={checked.errors.externalOrigins} listError={shown.externalOriginsList} showErrors={attempted} onChange={setOrigins} />
        <ListField id="auth-endpoints" label="Sign-in API endpoints" itemLabel="Endpoint" addLabel="Add endpoint" max={3} rows={endpoints} errors={checked.errors.authEndpoints} listError={shown.authEndpointsList} showErrors={attempted} onChange={setEndpoints} />
        <Field id="journey-time-limit" label="Journey time limit"><div className="flex items-center gap-2"><Input id="journey-time-limit" type="number" inputMode="decimal" min={1} max={30} step="any" required value={minutes} aria-invalid={Boolean(shown.timeout) || undefined} className="w-28" onChange={event => setMinutes(event.target.value)} /><span className="text-sm text-muted-foreground">min</span></div><FieldError>{shown.timeout}</FieldError></Field>
      </fieldset>
      <ErrorText>{error}</ErrorText>
      <DialogFooter><Button type="button" variant="outline" disabled={saving} onClick={onClose}>Cancel</Button><Button type="submit" disabled={saving}>{saving && <LoaderCircle className="motion-safe:animate-spin" />}Save</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}

function GenerateTestsDialog({ config, cases, analysis, accounts, onGenerate, onClose, focusFallback }) {
  const returnFocus = useReturnFocus(focusFallback);
  const [scope, setScope] = useState(config.scope || '');
  const [replace, setReplace] = useState(() => new Set(defaultReplaceIds(cases)));
  const [account, setAccount] = useState(() => initialAccount(accounts));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const replaceCaseIds = cases.filter(item => replace.has(item.id)).map(item => item.id);
  const roomError = generateError(cases.length, replaceCaseIds.length);
  function toggle(id, checked) { setReplace(current => { const next = new Set(current); if (checked) next.add(id); else next.delete(id); return next; }); }
  async function submit(event) {
    event.preventDefault();
    if (saving) return;
    if (roomError) return setError(roomError);
    const chosen = accountRequest(account, accounts);
    if (chosen.error) return setError(chosen.error);
    setAccount({ ...account, username: '', password: '' }); setSaving(true); setError('');
    try { await onGenerate({ ...config, scope: scope.trim() }, { replaceCaseIds, account: chosen.request }); }
    catch (failure) { setError(failure.message); setSaving(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !saving) onClose(); }}><DialogContent aria-describedby={undefined} showCloseButton={!saving} onCloseAutoFocus={returnFocus}>
    <DialogHeader><DialogTitle>Generate tests</DialogTitle></DialogHeader>
    <form onSubmit={submit} autoComplete="off" className="space-y-4">
      <fieldset disabled={saving} className="space-y-5">
        <Field id="generation-focus" label="Test focus"><Textarea id="generation-focus" rows={3} maxLength={4000} value={scope} onChange={event => setScope(event.target.value)} /></Field>
        {cases.length > 0 && <div role="group" aria-labelledby="replace-tests-label" className="grid min-w-0 gap-2">
          <div className="flex items-center justify-between gap-3"><Label id="replace-tests-label">Replace tests</Label><span className="text-xs tabular-nums text-muted-foreground">{replaceCaseIds.length}/{cases.length}</span></div>
          <ul className="generate-replace-list max-h-56 overflow-y-auto rounded-lg border">{cases.map(item => <li key={item.id} className="flex items-start gap-3 border-b px-3 py-2.5 last:border-b-0">
            <Checkbox id={`replace-${item.id}`} className="mt-0.5" checked={replace.has(item.id)} onCheckedChange={checked => toggle(item.id, checked === true)} />
            <Label htmlFor={`replace-${item.id}`} className="min-w-0 flex-1 break-words font-normal leading-5">{item.name}</Label>
            {item.needsReview ? <Badge variant="outline" className="shrink-0">Draft</Badge> : !item.steps?.length && <Badge variant="outline" className="shrink-0">No steps</Badge>}
          </li>)}</ul>
        </div>}
        <TestAccountFields id="generate" accounts={accounts} account={account} onChange={next => { setAccount(next); setError(''); }} />
        {analysis && typeof analysis.authenticated === 'boolean' && <Badge variant="outline">{analysis.authenticated ? 'Last explored signed in' : 'Last explored signed out'}</Badge>}
      </fieldset>
      <ErrorText>{error || roomError}</ErrorText>
      <DialogFooter><Button type="button" variant="outline" disabled={saving} onClick={onClose}>Cancel</Button><Button type="submit" disabled={saving || Boolean(roomError)}>{saving && <LoaderCircle className="motion-safe:animate-spin" />}Generate</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}

function RunTestsDialog({ title, count, accounts, engines = { browserUse: true, playwright: false }, disabled, notice = '', onRun, onClose, focusFallback }) {
  const { browserUse, playwright } = engines;
  const returnFocus = useReturnFocus(focusFallback);
  const [concurrency, setConcurrency] = useState('2');
  const [engine, setEngine] = useState(browserUse ? 'browser-use' : 'playwright');
  const blocked = disabled || (playwright ? engine === 'browser-use' && !browserUse : !browserUse);
  const [account, setAccount] = useState(() => initialAccount(accounts));
  const [error, setError] = useState('');
  const serial = usesAccount(account);
  function submit(event) {
    event.preventDefault();
    if (blocked) return;
    const chosen = accountRequest(account, accounts);
    if (chosen.error) return setError(chosen.error);
    setAccount({ ...account, username: '', password: '' });
    // One account shares application state, so its journeys run one at a time.
    try { onRun(chosen.request, count > 1 && !serial ? Number(concurrency) : 1, playwright ? engine : 'browser-use'); }
    catch (failure) { setError(failure.message); }
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent aria-describedby={undefined} onCloseAutoFocus={returnFocus}>
    <DialogHeader><DialogTitle className="break-words">{title}</DialogTitle></DialogHeader>
    <form onSubmit={submit} autoComplete="off" className="space-y-4">
      <fieldset disabled={disabled || !browserUse && !playwright} className="space-y-4">
        {playwright && <Field id="run-engine" label="Engine"><Select value={engine} onValueChange={setEngine}><SelectTrigger id="run-engine"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="browser-use" disabled={!browserUse}>Browser Use</SelectItem><SelectItem value="playwright">Playwright</SelectItem></SelectContent></Select></Field>}
        {count > 1 && <Field id="run-concurrency" label="Parallel browsers"><Select value={serial ? '1' : concurrency} disabled={serial} onValueChange={setConcurrency}><SelectTrigger id="run-concurrency"><SelectValue /></SelectTrigger><SelectContent>{[1,2,3,4].map(value => <SelectItem key={value} value={String(value)}>{value}</SelectItem>)}</SelectContent></Select></Field>}
        <TestAccountFields id="run" accounts={accounts} account={account} onChange={next => { setAccount(next); setError(''); }} />
      </fieldset>
      <ErrorText>{error || notice}</ErrorText>
      <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" disabled={blocked}><Play />Run</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}

function BusinessCaseEditor({ item, draftKey, onSave, onClose, focusFallback }) {
  const returnFocus = useReturnFocus(focusFallback);
  const original = caseDraftOriginal(item);
  const [draft, setDraft] = useState(() => caseDrafts.get(draftKey)?.original === original ? caseDrafts.get(draftKey).draft : ({ ...item, preconditions: (item.preconditions || []).join('\n'), expectedOutcomes: (item.expectedOutcomes || []).join('\n'), assertions: item.assertions || [], stepRows: (item.steps || []).map(stepRow), isolation: item.isolation || 'shared' }));
  const edited = useRef(caseDrafts.get(draftKey)?.original === original);
  useEffect(() => {
    if (edited.current) caseDrafts.set(draftKey, { original, draft });
  }, [draftKey, original, draft]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const change = (key, value) => { edited.current = true; setDraft(previous => ({ ...previous, [key]: value })); };
  async function submit(event) {
    event.preventDefault(); setError('');
    if (!draft.name.trim() || !draft.goal.trim()) return setError('Add a name and business goal.');
    const expectedOutcomes = lines(draft.expectedOutcomes);
    const preconditions = lines(draft.preconditions);
    if (!expectedOutcomes.length) return setError('Add an expected outcome.');
    if ([expectedOutcomes, preconditions].some(values => values.length > 20 || values.some(value => value.length > 2000))) return setError('Use up to 20 lines per field, with at most 2,000 characters each.');
    if (draft.assertions.some(check => !CHECKS[check.type] || !check.value.trim())) return setError('Complete or remove each check.');
    const { steps, error: stepError } = buildJourneySteps(draft.stepRows, item.steps || []);
    if (stepError) return setError(stepError);
    const { stepRows: _rows, ...fields } = draft;
    const next = { ...fields, steps, name: draft.name.trim(), goal: draft.goal.trim(), preconditions, expectedOutcomes, assertions: draft.assertions.map(check => ({ type: check.type, value: check.value.trim() })), needsReview: false };
    // Existing step-less cases stay runnable unchanged; any reviewed edit needs real milestones.
    const legacyUnchanged = !item.needsReview && !item.steps?.length && DEFINITION.every(key => JSON.stringify(next[key] ?? []) === JSON.stringify(item[key] ?? [])) && next.isolation === (item.isolation || 'shared');
    const countError = reviewedStepError(steps, { legacyUnchanged });
    if (countError) return setError(countError);
    setSaving(true);
    try {
      await onSave(next);
      caseDrafts.delete(draftKey);
    } catch (failure) { setError(failure.message); setSaving(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !saving) onClose(); }}>
    <DialogContent aria-describedby={undefined} className="case-editor sm:max-w-2xl" onCloseAutoFocus={returnFocus}>
      <DialogHeader><DialogTitle>{item.needsReview ? 'Review test' : item.name ? 'Edit test' : 'New test'}</DialogTitle></DialogHeader>
      <form className="case-editor-form" onSubmit={submit}>
        <div className="case-editor-body">
        <fieldset disabled={saving} className="space-y-4">
          <Field id="browser-case-name" label="Name"><Input id="browser-case-name" required maxLength={120} value={draft.name} onChange={event => change('name', event.target.value)} /></Field>
          <Field id="browser-case-goal" label="Business goal"><Textarea id="browser-case-goal" required rows={3} maxLength={4000} value={draft.goal} onChange={event => change('goal', event.target.value)} /></Field>
          <JourneyStepEditor rows={draft.stepRows} onChange={rows => change('stepRows', rows)} />
          <div className="flex items-center justify-between gap-3"><Label htmlFor="browser-case-isolation">Independent test data</Label><Switch id="browser-case-isolation" checked={draft.isolation === 'isolated'} onCheckedChange={checked => change('isolation', checked ? 'isolated' : 'shared')} /></div>
          <Field id="browser-case-preconditions" label="Preconditions"><Textarea id="browser-case-preconditions" rows={3} maxLength={8000} value={draft.preconditions} onChange={event => change('preconditions', event.target.value)} /></Field>
          <Field id="browser-case-outcomes" label="Expected outcomes"><Textarea id="browser-case-outcomes" required rows={4} maxLength={8000} value={draft.expectedOutcomes} onChange={event => change('expectedOutcomes', event.target.value)} /></Field>
          <Collapsible>
            <CollapsibleTrigger asChild><Button type="button" variant="ghost" className="w-full justify-between px-0 [&[data-state=open]>svg]:rotate-180">Final checks<ChevronDown /></Button></CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 pt-2">
              {draft.assertions.map((check, index) => <div key={index} className="flex flex-wrap items-center gap-2">
                <Select value={check.type} onValueChange={type => change('assertions', draft.assertions.map((entry, current) => current === index ? { ...entry, type } : entry))}><SelectTrigger aria-label={`Check ${index + 1} type`} className="w-36"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(CHECKS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select>
                <Input aria-label={`Check ${index + 1} value`} value={check.value} className="min-w-32 flex-1" maxLength={2000} onChange={event => change('assertions', draft.assertions.map((entry, current) => current === index ? { ...entry, value: event.target.value } : entry))} />
                <Button type="button" variant="ghost" size="icon" aria-label={`Remove check ${index + 1}`} onClick={() => change('assertions', draft.assertions.filter((_, current) => current !== index))}><Trash2 /></Button>
              </div>)}
              <Button type="button" variant="outline" size="sm" disabled={draft.assertions.length >= 20} onClick={() => change('assertions', [...draft.assertions, { type: 'text-visible', value: '' }])}><Plus />Add check</Button>
            </CollapsibleContent>
          </Collapsible>
          {!!item.evidence?.length && <Collapsible><CollapsibleTrigger asChild><Button type="button" variant="ghost" className="w-full justify-between px-0 [&[data-state=open]>svg]:rotate-180">Source evidence<ChevronDown /></Button></CollapsibleTrigger><CollapsibleContent><ul className="space-y-2 text-xs text-muted-foreground">{item.evidence.map((source, index) => <li className="break-all" key={index}>{source.path}{source.line ? `:${source.line}` : ''}</li>)}</ul></CollapsibleContent></Collapsible>}
        </fieldset>
        <ErrorText>{error}</ErrorText>
        </div>
        <DialogFooter>{edited.current && <Button type="button" variant="ghost" disabled={saving} onClick={() => { caseDrafts.delete(draftKey); onClose(); }}>Discard draft</Button>}<Button type="button" variant="outline" disabled={saving} onClick={onClose}>Cancel</Button><Button type="submit" disabled={saving}>{saving && <LoaderCircle className="motion-safe:animate-spin" />}{item.needsReview ? 'Review & save' : 'Save'}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

function CodeActions({ code, modelConfigured, onGenerate, onStop, onApprove }) {
  return <>
    <DropdownMenuSeparator />
    {code.generating
      ? <><DropdownMenuItem disabled><LoaderCircle className="motion-safe:animate-spin" />Generating code</DropdownMenuItem><DropdownMenuItem onSelect={onStop}><Square />Stop generating</DropdownMenuItem></>
      : <DropdownMenuItem disabled={!modelConfigured} onSelect={onGenerate}><Code />{code.state ? 'Regenerate code' : 'Generate code'}</DropdownMenuItem>}
    {code.state === 'Draft' && <DropdownMenuItem disabled={!code.approvable || code.generating} onSelect={onApprove}><Check />Approve code</DropdownMenuItem>}
  </>;
}

function DeleteCaseDialog({ item, pending, disabled, onDelete, onClose, focusFallback }) {
  const returnFocus = useReturnFocus(focusFallback);
  const [error, setError] = useState('');
  return <AlertDialog open onOpenChange={open => { if (!open && !pending) onClose(); }}>
    <AlertDialogContent onCloseAutoFocus={returnFocus}>
      <AlertDialogHeader><AlertDialogTitle>Delete test?</AlertDialogTitle><AlertDialogDescription className="break-words">{item.name}</AlertDialogDescription></AlertDialogHeader>
      <ErrorText>{error}</ErrorText>
      <AlertDialogFooter><AlertDialogCancel disabled={Boolean(pending)}>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={disabled} onClick={async event => {
        event.preventDefault();
        if (disabled) return;
        setError('');
        try { await onDelete(); }
        catch (failure) { setError(failure.message); }
      }}>{pending ? 'Deleting…' : 'Delete test'}</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}

export default function BrowserTestingPanel({ repoPath, stageId, busy = false, initialRunId = '', initialWatch = false, initialCaseId = '', caseRequestKey = '', view = 'tests', visible = true, environmentStatus, targetSuggestions = [], environmentError = '', onAppSettings, onBusyChange }) {
  const [stage, snapshot] = useTestStage(stageId, visible ? ['browser'] : []);
  const data = snapshot.browser;
  const config = snapshot.drafts.config || data.config;
  const loading = snapshot.loading.browser;
  const pending = snapshot.pending;
  const error = snapshot.error || snapshot.pollErrors.browser;
  const dirty = Boolean(snapshot.dirty.config);
  const [editingCase, setEditingCase] = useState(null);
  const [caseFilter, setCaseFilter] = useState('all');
  const [deletingCase, setDeletingCase] = useState(null);
  const [creatingCase, setCreatingCase] = useState(false);
  const [configDialog, setConfigDialog] = useState(null);
  const [runDialog, setRunDialog] = useState(null);
  const [focusedCase, setFocusedCase] = useState(null);
  const [watching, setWatching] = useState(() => initialRunId ? { id: initialRunId, mode: 'run' } : null);
  const mounted = useRef(true);
  const openedCase = useRef('');
  const caseList = useRef(null);
  const openedWatch = useRef('');
  const root = useRef(null);
  const editTarget = useRef(null);
  // When a dialog's opener has gone (a deleted case, a met prerequisite), focus returns to the
  // case card, then the settings entry point, then the inspector sheet itself.
  const sheet = () => root.current?.closest('[data-slot="sheet-content"]') || null;
  const cardOf = id => [...(caseList.current?.children || [])].find(node => node.dataset.caseId === id) || null;
  const focusCase = id => () => cardOf(id) || sheet();
  const focusSettings = () => editTarget.current || sheet();
  const refresh = useCallback(() => stage.refresh('browser'), [stage]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setRunDialog(null); }, [repoPath, stageId, config.targetUrl, visible, view]);
  useEffect(() => { onBusyChange?.(Boolean(pending)); return () => onBusyChange?.(false); }, [pending, onBusyChange]);
  const activeRun = data.runs.find(run => ACTIVE.has(run.status));
  const cases = data.cases;
  const visibleCases = cases.filter(item => caseFilter === 'all' || caseFilter === 'review' && item.needsReview || caseFilter === 'selected' && item.selected || caseFilter === 'failed' && browserCaseState(item, data.runs).status === 'failed');
  const selected = cases.filter(item => item.selected && reviewed(item));
  const reviewCount = cases.filter(item => item.needsReview).length;
  const capabilities = data.capabilities;
  const accounts = data.accounts || [];
  const openRouterConfigured = Boolean(capabilities?.modelConfigured && capabilities.provider === 'openrouter');
  const preparation = data.preparation;
  const unavailable = Boolean(browserUnavailable(capabilities));
  const runnable = items => { const engines = runEngines(capabilities, items, data.specs); return engines.browserUse || engines.playwright; };
  const disabled = loading || busy || Boolean(pending) || Boolean(activeRun);
  const validTarget = validUrl(config.targetUrl);
  const readiness = browserReadiness(capabilities, validTarget);
  const showReadiness = !loading && readiness.some(item => !item.ready);
  const wait = activeRun ? activeRun.mode === 'discover' ? 'Generating tests' : 'Run in progress' : loading ? 'Loading' : disabled ? 'Wait for the current action to finish' : '';
  const toolbar = testToolbar({ wait, readiness, caseCount: cases.length, selectedCount: selected.length, maxCases: MAX_CASES });
  const emphasis = action => toolbar.primary === action ? 'default' : 'outline';
  const runCases = runDialog?.caseIds ? cases.filter(item => runDialog.caseIds.includes(item.id) && reviewed(item)) : selected;
  const runBlocked = runDialog?.caseIds ? oneOffSelection(cases, runCases.map(item => item.id)).error || '' : '';
  const concurrencyLabel = browserConcurrencyLabel(activeRun);
  useEffect(() => { if (!loading) pruneCaseDrafts(repoPath, stageId, cases); }, [loading, repoPath, stageId, cases]);
  useEffect(() => {
    if (disabled) return;
    const restored = settleOneOffRun(repoPath, stageId, { cases, runs: data.runs, active: run => ACTIVE.has(run.status) });
    if (restored) updateCases(restored);
  }, [repoPath, stageId, disabled, cases, data.runs]);
  useEffect(() => {
    if (!focusedCase) return undefined;
    const timer = setTimeout(() => setFocusedCase(null), 1200);
    return () => clearTimeout(timer);
  }, [focusedCase]);
  // A graph request waits for the tests view; with the view in its dependencies it is handled
  // as soon as that view shows, never later on an unrelated poll.
  useEffect(() => {
    if (loading || !initialCaseId || view !== 'tests') return;
    const request = `${initialCaseId}:${caseRequestKey}`;
    if (openedCase.current === request) return;
    const { kind, caseId } = journeyRequest(initialCaseId);
    if (kind === 'new' || kind === 'generate') {
      openedCase.current = request;
      if (kind === 'new') setCreatingCase(true);
      else { const next = generateRequestDialog({ disabled, unavailable, validTarget: validUrl(config.targetUrl) }); if (next) setConfigDialog(next); }
      return;
    }
    const item = data.cases.find(value => value.id === caseId);
    if (!item) return;
    const card = [...(caseList.current?.children || [])].find(node => node.dataset.caseId === item.id);
    if (!card && caseFilter !== 'all') { setCaseFilter('all'); return; }
    if (!card && kind !== 'run') return;
    openedCase.current = request;
    if (card) { card.scrollIntoView({ block: 'nearest' }); card.focus({ preventScroll: true }); setFocusedCase({ id: item.id, request }); }
    if (kind === 'run' && reviewed(item)) setRunDialog({ caseIds: [item.id], title: item.name });
    // A watch request opens its run through the watch effect; a plain case click opens the case itself.
    if (kind === 'case' && !initialWatch) openCase(item);
  }, [loading, view, initialCaseId, caseRequestKey, initialWatch, data.cases, caseFilter, config.targetUrl, disabled, unavailable]);
  useEffect(() => {
    if (loading || !initialWatch) return;
    const request = `${initialRunId}:${caseRequestKey}`;
    if (openedWatch.current === request) return;
    const run = initialRunId ? data.runs.find(value => value.id === initialRunId)
      : data.runs.find(value => ACTIVE.has(value.status)) || data.runs.find(value => value.mode === 'run');
    if (run) { openedWatch.current = request; setWatching({ ...run, focusCaseId: journeyRequest(initialCaseId).kind === 'case' ? initialCaseId : '' }); }
  }, [loading, initialWatch, initialRunId, initialCaseId, caseRequestKey, data.runs]);

  async function persistConfig(tx, nextConfig = config) {
    if (!validUrl(nextConfig.targetUrl)) throw new Error('Enter an HTTP or HTTPS target URL.');
    return tx.save('config', { config: nextConfig });
  }
  async function perform(name, work) {
    try { return await stage.perform('browser', name, work); }
    catch { /* The shared workspace retains the actionable error. */ }
  }
  // A case always opens its review/edit view; opening never approves or runs. Its run opens from the status badge.
  function openCase(item) { setEditingCase(item); }
  async function saveCase(item) {
    await stage.saveBrowserCase(item, editingCase);
    if (mounted.current && stage.isCurrent()) setEditingCase(null);
  }
  async function createCase(description) {
    await stage.perform('browser', 'draft', tx => tx.post('draft', { description }));
    if (mounted.current && stage.isCurrent()) setCreatingCase(false);
  }
  function transcribeDescription(audio, options) {
    return stage.perform('browser', 'transcribe', tx => tx.post('transcribe', audio, options));
  }
  function updateCases(next) { void perform('cases', tx => tx.post('cases', { cases: next, baseCases: cases })); }
  // Playwright code for one reviewed journey: generated as a draft, approved only after a passing run of that draft.
  function codeAction(name, action, input) { void perform(name, tx => tx.post(action, input)); }
  // account: the request's { accountId } or { credentials }, from the dialog's account choice.
  function start(mode, nextConfig = config, account = {}, options = {}) {
    if (disabled) throw new Error('Wait for the current action to finish.');
    const caseIds = mode === 'run' ? (options.caseIds || selected.map(item => item.id)) : [];
    const oneOff = mode === 'run' && options.caseIds ? oneOffSelection(cases, caseIds) : { added: [], cases };
    if (oneOff.error) throw new Error(oneOff.error);
    setConfigDialog(null);
    setRunDialog(null);
    if (mode === 'discover') setWatching({ id: null, mode });
    void perform(mode, async tx => {
      try {
        await persistConfig(tx, nextConfig);
        // The controller runs only selected, reviewed cases; a one-off run selects its case for this run alone.
        if (oneOff.added.length) await tx.post('cases', { cases: oneOff.cases, baseCases: cases });
        const input = mode === 'discover'
          ? { ...(options.replaceCaseIds?.length ? { replaceCaseIds: options.replaceCaseIds, baseCases: cases } : {}), ...account }
          : { caseIds, concurrency: options.concurrency || 2, ...(options.engine === 'playwright' ? { engine: 'playwright' } : {}), ...account };
        const result = await tx.post(mode === 'discover' ? 'discover' : 'run', input).catch(async failure => {
          // The run never started, so its one-off selection is undone at once.
          const restored = restoreSelection(oneOff.cases, oneOff.added);
          if (restored) await tx.post('cases', { cases: restored, baseCases: oneOff.cases }).catch(() => {});
          throw failure;
        });
        if (mode === 'run') rememberOneOffRun(repoPath, stageId, result.run?.id, oneOff.added);
        if (mode === 'discover' && mounted.current && stage.isCurrent()) setWatching({ ...result.run, mode });
      } catch (failure) {
        if (mode === 'discover' && mounted.current && stage.isCurrent()) setWatching({ id: null, mode, error: failure.message });
        throw failure;
      } finally { account = undefined; }
    });
  }
  const finished = useCallback(() => { void refresh(); }, [refresh]);

  return <div ref={root} className="test-workspace space-y-5">
    <ErrorText>{error || environmentError}</ErrorText>
    {view === 'tests' && <>
      {(preparation?.status === 'preparing' || ['queued', 'creating', 'preparing'].includes(environmentStatus)) && <Badge variant="secondary">Creating environment</Badge>}
      {preparation?.status === 'discovering' && !activeRun && <Badge variant="secondary">Generating tests</Badge>}
      {['needs_setup', 'failed'].includes(preparation?.status) && <div className="flex flex-wrap items-center gap-2"><Badge variant={preparation.status === 'failed' ? 'destructive' : 'outline'}>{preparation.status === 'failed' ? 'Preparation failed' : 'Setup required'}</Badge><ErrorText>{preparation.error}</ErrorText></div>}
      {showReadiness && <Readiness items={readiness} primary={toolbar.primary} targetBlocker={toolbar.blockers.target} onTarget={() => setConfigDialog('settings')} onAppSettings={onAppSettings} />}
      {validTarget && <div className="test-target flex min-w-0 items-center gap-2">
        <Button asChild variant="link" className="h-auto min-w-0 max-w-full shrink justify-start px-0 py-1"><a href={config.targetUrl} target="_blank" rel="noopener noreferrer"><span className="truncate">{config.targetUrl}</span><ExternalLink /></a></Button>
        <Button ref={editTarget} variant="ghost" size="icon-sm" disabled={disabled} aria-label="Edit test settings" onClick={() => setConfigDialog('settings')}><Pencil /></Button>
      </div>}
      <div className="test-toolbar @container flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-2 @max-md:w-full">
          <BlockedButton reason={toolbar.blockers.generate} size="sm" variant={emphasis('generate')} className={NARROW_TOOL} onClick={() => setConfigDialog('generate')}><Sparkles />Generate</BlockedButton>
          <BlockedButton reason={toolbar.blockers.add} size="sm" variant="outline" className={NARROW_TOOL} onClick={() => setCreatingCase(true)}><Plus />Add test</BlockedButton>
          <BlockedButton reason={toolbar.blockers.run} size="sm" variant={emphasis('run')} className={NARROW_TOOL} onClick={() => setRunDialog({ caseIds: null, title: 'Run integration tests' })}><Play />Run selected{selected.length > 0 && ` (${selected.length})`}</BlockedButton>
        </div>
        {dirty && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => perform('config', persistConfig)}>Save</Button>}
      </div>
      {activeRun && <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap items-center gap-2"><Badge variant="secondary">{activeRun.mode === 'discover' ? 'Exploring' : 'Running'}</Badge>{concurrencyLabel && <Badge variant="outline">{concurrencyLabel}</Badge>}</div><Button size="sm" variant="outline" onClick={() => setWatching(activeRun)}><Eye />Watch live</Button></div>}
      {loading && !cases.length && <TestListSkeleton label="Loading integration tests" />}
      {cases.length > 0 && <div className="flex items-center justify-between gap-3"><Select value={caseFilter} onValueChange={setCaseFilter}><SelectTrigger className="w-44" aria-label="Filter tests"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All tests</SelectItem><SelectItem value="review">Needs review</SelectItem><SelectItem value="failed">Failed</SelectItem><SelectItem value="selected">Selected</SelectItem></SelectContent></Select>{reviewCount > 0 && <span className="text-xs tabular-nums text-muted-foreground">{reviewCount} to review</span>}</div>}
      <div ref={caseList} className="journey-list grid gap-5" aria-label="Integration tests">
        {visibleCases.map(item => {
          const status = browserCaseState(item, data.runs);
          const run = browserCaseRun(item, data.runs);
          return <JourneyCard key={item.id} item={item} run={run} status={status.status} label={status.label} repoPath={repoPath} stageId={stageId} focused={focusedCase?.id === item.id}
            selection={<Checkbox className="mt-0.5" checked={Boolean(item.selected)} disabled={disabled || !reviewed(item) || (!item.selected && selected.length >= 30)} aria-label={`Select ${item.name}`} onCheckedChange={checked => updateCases(cases.map(current => current.id === item.id ? { ...current, selected: checked === true } : current))} />}
            spec={data.specs?.[item.id]}
            actions={<DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" className="-my-1.5 shrink-0" disabled={disabled} aria-label={`Actions for ${item.name}`}><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">{reviewed(item) && <DropdownMenuItem disabled={!runnable([item]) || !validUrl(config.targetUrl)} onSelect={() => setRunDialog({ caseIds: [item.id], title: item.name })}><Play />Run</DropdownMenuItem>}<DropdownMenuItem onSelect={() => setEditingCase(item)}>{item.needsReview ? 'Review' : 'Edit'}</DropdownMenuItem>
              {reviewed(item) && <CodeActions code={journeyCode(data.specs?.[item.id])} modelConfigured={openRouterConfigured} onGenerate={() => codeAction('generate-code', 'specs/generate', { caseId: item.id })} onStop={() => codeAction('stop-code', 'specs/generate/cancel', { caseId: item.id })} onApprove={() => codeAction('approve-code', 'specs/approve', { caseId: item.id, hash: data.specs[item.id].hash })} />}
              <DropdownMenuSeparator /><DropdownMenuItem variant="destructive" onSelect={() => setDeletingCase(item)}><Trash2 />Delete</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}
            onSkip={run && ACTIVE.has(run.status) ? () => perform('skip', tx => tx.post('skip', { id: run.id, caseId: item.id })) : undefined}
            skipping={pending === 'skip'}
            onViewRun={run ? () => setWatching({ ...run, focusCaseId: item.id }) : undefined}
            onInspect={() => openCase(item)} />;
        })}
      </div>
      {!!cases.length && !visibleCases.length && <p role="status" className="py-8 text-center text-sm text-muted-foreground">No matching tests</p>}
      {!cases.length && !loading && <p className="workspace-empty text-sm text-muted-foreground">No integration tests</p>}
    </>}
    {view === 'runs' && <>
      {!data.runs.length && !loading && <p className="workspace-empty text-sm text-muted-foreground">No runs</p>}
      {loading && !data.runs.length && <TestListSkeleton label="Loading test runs" />}
      <ItemGroup className="test-run-list" aria-label="Test runs">{[...data.runs].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(run => <Item role="listitem" size="sm" variant="default" className="test-run-row" key={run.id}><ItemContent className="min-w-0"><Button variant="ghost" className="h-auto w-full items-start justify-between gap-3 whitespace-normal px-0 py-1" onClick={() => setWatching(run)}><span className="min-w-0 flex-1 space-y-1 text-left"><span className="block break-words font-medium">{browserRunTitle(run)}</span><span className="block text-xs font-normal tabular-nums text-muted-foreground">{dateLabel(run.createdAt)}</span></span><Badge className="shrink-0" variant={run.status === 'failed' ? 'destructive' : 'secondary'}>{browserRunLabel(run)}</Badge><Eye className="mt-0.5 shrink-0" /></Button></ItemContent></Item>)}</ItemGroup>
    </>}
    {deletingCase && <DeleteCaseDialog key={deletingCase.id} item={deletingCase} pending={pending} disabled={disabled} focusFallback={sheet} onClose={() => setDeletingCase(null)} onDelete={async () => {
      await stage.perform('browser', 'cases', tx => tx.post('cases', { cases: cases.filter(item => item.id !== deletingCase.id), baseCases: cases }));
      if (mounted.current && stage.isCurrent()) setDeletingCase(null);
    }} />}
    {editingCase && <BusinessCaseEditor key={editingCase.id} draftKey={caseDraftKey(repoPath, stageId, editingCase.id)} item={editingCase} focusFallback={focusCase(editingCase.id)} onClose={() => setEditingCase(null)} onSave={saveCase} />}
    {runDialog && visible && view === 'tests' && <RunTestsDialog key={`${repoPath}:${stageId}:${config.targetUrl}:${runDialog.caseIds?.join(',') || 'selected'}`} title={runDialog.title} count={runCases.length} accounts={accounts} engines={runEngines(capabilities, runCases, data.specs)} disabled={disabled || !validUrl(config.targetUrl) || !runCases.length || Boolean(runBlocked)} notice={runBlocked} focusFallback={runDialog.caseIds?.length === 1 ? focusCase(runDialog.caseIds[0]) : sheet} onRun={(account, concurrency, engine) => start('run', config, account, { concurrency, engine, caseIds: runDialog.caseIds ? runCases.map(item => item.id) : undefined })} onClose={() => setRunDialog(null)} />}
    {creatingCase && <NewTestDialog draftKey={newTestDraftKey(repoPath, stageId)} focusFallback={sheet} onClose={() => setCreatingCase(false)} onCreate={createCase} onTranscribe={transcribeDescription} onAppSettings={onAppSettings} modelChecked={Boolean(capabilities)} modelConfigured={openRouterConfigured} voiceConfigured={openRouterConfigured} />}
    {watching && <BrowserAgentViewer key={watching.id || `pending-${watching.mode}`} repoPath={repoPath} stageId={stageId} runId={watching.id} mode={watching.mode} cases={cases} focusCaseId={watching.focusCaseId} startingError={watching.error} focusFallback={watching.focusCaseId ? focusCase(watching.focusCaseId) : sheet} onClose={() => setWatching(null)} onFinished={finished} />}
    {configDialog === 'settings' && <TestSettingsDialog config={config} suggestions={targetSuggestions} focusFallback={focusSettings} onClose={() => setConfigDialog(null)} onSave={async nextConfig => {
      await stage.perform('browser', 'config', tx => persistConfig(tx, nextConfig));
      if (mounted.current && stage.isCurrent()) setConfigDialog(null);
    }} />}
    {configDialog === 'generate' && <GenerateTestsDialog config={config} cases={cases} analysis={data.analysis} accounts={accounts} focusFallback={sheet} onClose={() => setConfigDialog(null)} onGenerate={async (nextConfig, { replaceCaseIds, account }) => start('discover', nextConfig, account, { replaceCaseIds })} />}
  </div>;
}
