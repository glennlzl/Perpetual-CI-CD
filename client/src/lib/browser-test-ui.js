const LABELS = { queued: 'Queued', pending: 'Queued', running: 'Running', skipping: 'Skipping…', skipped: 'Skipped', blocked: 'Blocked', cancelling: 'Cancelling…', unconfirmed: 'Unconfirmed', completed: 'Cases ready', passed: 'Passed', failed: 'Failed', cancelled: 'Cancelled', needs_review: 'Needs review', not_run: 'Not run' };
export const ACTIONS = { navigate: 'Navigate', go_to_url: 'Navigate', click: 'Click', click_element: 'Click', fill: 'Enter text', input: 'Enter text', input_text: 'Enter text', type: 'Enter text', scroll: 'Scroll', search: 'Search', search_page: 'Search page', search_google: 'Search', observe: 'Observe page', screenshot: 'Observe page', wait: 'Wait', done: 'Finish', extract: 'Read page', extract_content: 'Read page', switch_tab: 'Switch tab', open_tab: 'Open tab', go_back: 'Go back', send_keys: 'Press key', upload_file: 'Upload file', evaluate: 'Inspect page', check: 'Check outcome', report_journey_step: 'Report milestone', sign_in_with_test_account: 'Sign in', reload_page: 'Reload' };
export const CHECKS = { 'text-visible': 'Text visible', 'text-absent': 'Text absent', 'url-contains': 'URL contains', 'read-number': 'Read number', 'compare-number': 'Compare number' };
export const OUTCOMES = { satisfied: 'Satisfied', failed: 'Failed', uncertain: 'Uncertain' };
const ACTION_ERRORS = { action_not_allowed: 'Action blocked', navigation_not_allowed: 'Navigation blocked', attachments_not_allowed: 'Attachment blocked', credential_literal_rejected: 'Use account placeholder', credential_reference_invalid: 'Invalid account placeholder', credential_origin_mismatch: 'Login origin mismatch', credential_field_unavailable: 'Login field unavailable', credential_target_mismatch: 'Login tab mismatch', credential_frame_mismatch: 'Login frame mismatch', credential_field_type_mismatch: 'Wrong login field', credential_verification_failed: 'Login field not verified', browser_action_failed: 'Browser action failed', action_result_missing: 'No action result', journey_progress_invalid: 'Invalid journey progress', payment_live_mode_rejected: 'Live payment blocked' };
const BLOCKERS = { account: 'Account', fixture: 'Test data', integration: 'Integration', permission: 'Permission', environment: 'Environment' };
const LIMITS = { 'shared-data': 'Shared test data', account: 'Test account' };
const QUEUES = { 'shared-data': 'Waiting for shared test data', account: 'Waiting for test account' };
const OPS = { '<': '<', '>': '>', '=': '=', '!=': '≠' };
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const own = (map, key) => Object.hasOwn(map, key) ? map[key] : '';
const number = value => Number(value).toLocaleString('en-US', { maximumFractionDigits: 4 });
export const journeyActive = status => ['queued', 'pending', 'running', 'skipping', 'cancelling'].includes(status);
export const journeyStreaming = status => ['running', 'skipping', 'cancelling'].includes(status);
export const journeyProgress = (run, caseId) => run?.progress?.cases?.find(value => (value.caseId || value.id) === caseId);
// A finished journey replays its recordings, one per browser tab; a live one keeps streaming frames.
export function journeyRecordings({ repoPath, stageId, run, caseId, status }) {
  const videos = journeyProgress(run, caseId)?.videos;
  if (!run || journeyActive(status) || !Array.isArray(videos)) return [];
  return videos.map(file => `/api/browser/runs/${encodeURIComponent(run.id)}/video?${new URLSearchParams({ repoPath, stageId, caseId, file })}`);
}
// Lists open only journeys that are live or failed; finished journeys stay collapsed until asked.
export const journeyOpenByDefault = status => journeyActive(status) || status === 'failed';
// Only a failed journey's error reads as failure; blocked and review errors are context, not a verdict.
export const journeyErrorTone = status => status === 'failed' ? 'text-destructive' : 'text-muted-foreground';

// A journey's own reported events (actions and milestone states), so one journey acting never refreshes another's frame.
export function journeyRevision(progress) {
  if (!progress) return undefined;
  return `${progress.actionCount ?? progress.actions?.length ?? 0}:${(progress.steps || []).map(step => step.status).join(',')}`;
}

const RUNTIME_PROJECT = /^\/[\w./-]+$/;
// The runtime and its Chromium install with the documented commands (docs/journeys.md),
// relative to the Perpetual source unless the controller names its path.
export function browserInstallCommand(capabilities) {
  if (!capabilities || (capabilities.runtimeInstalled && capabilities.browserInstalled !== false)) return '';
  const project = typeof capabilities.runtimeProject === 'string' && RUNTIME_PROJECT.test(capabilities.runtimeProject) ? capabilities.runtimeProject : 'integrations/browser-use';
  const chromium = `uv run --project ${project} python -m playwright install chromium`;
  return capabilities.runtimeInstalled ? chromium : `uv sync --project ${project} --frozen\n${chromium}`;
}

// Every prerequisite of Generate and Run, in fix order, each with its own fix. Unknown capabilities
// are not missing; the panel re-checks once the full view loads. App Settings fixes only the key.
export function browserReadiness(capabilities, validTarget = false) {
  const items = [{ id: 'target', label: 'Target URL', ready: Boolean(validTarget), blocker: 'Set a target URL' }];
  if (!capabilities) return items;
  const runtime = Boolean(capabilities.runtimeInstalled);
  items.push({ id: 'runtime', label: 'Browser runtime', ready: runtime && capabilities.browserInstalled !== false, blocker: runtime ? 'Install Chromium' : 'Install the browser runtime', command: browserInstallCommand(capabilities) });
  items.push({ id: 'model', label: 'OpenRouter API Key', ready: Boolean(capabilities.modelConfigured), blocker: 'Add an OpenRouter API Key' });
  return items;
}
const blockersOf = items => items.filter(item => !item.ready).map(item => item.blocker);
// Every missing capability, one per line; the target URL is checked on its own.
export const browserUnavailable = capabilities => blockersOf(browserReadiness(capabilities, true)).join('\n');

// The first unmet prerequisite is the primary action (target → runtime → key → tests → run);
// every disabled action lists all of its blockers, one per line.
export function testToolbar({ wait = '', readiness = [], caseCount = 0, selectedCount = 0, maxCases = Infinity }) {
  const missing = readiness.filter(item => !item.ready);
  const generate = wait || blockersOf(missing).join('\n');
  const blockers = { target: wait, generate, add: wait || (caseCount >= maxCases ? `Limit of ${maxCases} tests` : ''), run: generate || (selectedCount ? '' : 'Select tests') };
  const primary = missing[0]?.id || (!caseCount ? 'generate' : selectedCount ? 'run' : '');
  return { primary, blockers };
}

// A new graph request selects its own tab in the same render; otherwise the viewer's choice stands.
export function inspectorTab(state, initialTab, requestKey = '') {
  const request = `${initialTab}\u0000${requestKey}`;
  if (state?.request === request) return state;
  return { request, tab: initialTab === 'browser-runs' ? 'browser-runs' : 'browser' };
}

export function browserRunLabel(run) {
  const status = typeof run === 'string' ? run : run?.status;
  if (run?.mode === 'run' && status === 'completed') return 'Finished with skips';
  return LABELS[status] || status || 'Not run';
}

export function browserCaseRun(item, runs = []) {
  if (item.needsReview) return null;
  const run = [...runs].filter(value => value.mode === 'run' && value.caseIds?.includes(item.id)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  if (!run) return null;
  const original = run.caseSummaries?.find(value => value.id === item.id);
  if (!original || ['name','goal','preconditions','expectedOutcomes','assertions'].some(key => !same(original[key], item[key])) || !same(original.steps || [], item.steps || []) || (original.isolation || 'shared') !== (item.isolation || 'shared')) return null;
  return run;
}

// A draft awaiting approval and a finished run awaiting judgement share a status, not a label.
export function browserCaseState(item, runs = []) {
  const state = (status, label = browserRunLabel(status)) => ({ status, label, variant: status === 'failed' ? 'destructive' : ['running', 'passed'].includes(status) ? 'secondary' : 'outline' });
  if (item.needsReview) return state('needs_review');
  const run = browserCaseRun(item, runs);
  if (!run) return state('not_run');
  const result = run.results?.find(value => value.caseId === item.id);
  const progress = journeyProgress(run, item.id);
  let status = result?.status || progress?.status || (['queued', 'running'].includes(run.status) ? 'queued' : 'not_run');
  if (journeyActive(status) && !['queued', 'running'].includes(run.status)) status = ['failed','cancelled','skipped'].includes(run.status) ? run.status : 'needs_review';
  return state(status, status === 'needs_review' ? 'Review result' : undefined);
}

function checkText(check, captures) {
  const observed = Number.isFinite(check.observed);
  if (check.type === 'read-number') return observed ? `${check.label} ${number(check.observed)}` : check.label;
  if (check.type === 'compare-number') return observed && Number.isFinite(captures[check.than]) ? `${check.label} ${number(captures[check.than])} → ${number(check.observed)}` : observed ? `${check.label} → ${number(check.observed)}` : `${check.label} ${OPS[check.op] || check.op} ${check.than}`;
  return `${CHECKS[check.type] || check.type}: ${check.value}`;
}

// Merges reviewed milestone checks with independent results; values are observed by the runner, never the model.
export function browserJourneySteps(item, progress, status) {
  const captures = {};
  return (item.steps || []).map(step => {
    const observed = progress?.steps?.find(value => value.id === step.id);
    let stepStatus = observed?.status || 'pending';
    // A finished journey cannot leave a milestone spinning; unreached milestones stay pending.
    if (stepStatus === 'running' && !journeyActive(status)) stepStatus = ['skipped','cancelled'].includes(status) ? status : 'unconfirmed';
    const results = Array.isArray(observed?.checks) ? observed.checks : [];
    const checks = (step.checks || []).map((check, index) => {
      const found = results[index]?.type === check.type && typeof results[index].passed === 'boolean' ? results[index] : null;
      const merged = { ...check, ...(found ? { passed: found.passed, ...(Number.isFinite(found.observed) ? { observed: found.observed } : {}), ...(found.error ? { error: String(found.error) } : {}) } : {}) };
      const text = checkText(merged, captures);
      if (merged.type === 'read-number' && Number.isFinite(merged.observed)) captures[merged.name] = merged.observed;
      return { ...merged, text, result: merged.passed === true ? 'Passed' : merged.passed === false ? 'Failed' : 'Not checked' };
    });
    return { ...step, status: stepStatus, evidence: observed?.evidence, provenance: observed?.provenance, checks };
  });
}

// A person's run can use Playwright when each case has code, approved or a draft, for its current reviewed contract.
export const playwrightReady = (cases, specs) => cases.length > 0 && cases.every(item => typeof specs?.[item.id]?.hash === 'string' && specs[item.id].stale === false);
// A case's code: Draft until approved after a passing run, Stale once its reviewed contract changed; and its generation.
export function journeyCode(spec) {
  const state = typeof spec?.hash === 'string' ? spec.stale ? 'Stale' : spec.approved ? 'Approved' : 'Draft' : '';
  return { state, generating: spec?.generation?.status === 'running', error: spec?.generation?.status === 'failed' ? spec.generation.error || 'Code generation failed.' : '', approvable: state === 'Draft' && spec.verified === true };
}
// Browser Use needs its runtime and model; Playwright specs need neither.
export const runEngines = (capabilities, cases, specs) => ({ browserUse: !browserUnavailable(capabilities), playwright: playwrightReady(cases, specs) });
// A Playwright journey has no agent: its expected outcomes are backed by its reviewed checks alone. Only a final
// assertion evaluated on the reached end state fails them; a journey that stopped earlier never reached them.
export function checkedOutcome(result) {
  if (result?.status === 'passed') return { label: 'Checks · Passed', variant: 'outline' };
  if (result?.assertions?.some(check => check.passed === false && check.reached !== false)) return { label: 'Checks · Failed', variant: 'destructive' };
  return { label: result?.status === 'failed' || result?.assertions?.some(check => check.reached === false) ? 'Checks · Not reached' : 'Checks · Not confirmed', variant: 'outline' };
}

export function journeySegments(steps) {
  return steps.map(step => ({ id: step.id, title: step.title, state: step.status === 'completed' ? 'observed' : step.status === 'running' ? 'current' : ['blocked', 'failed'].includes(step.status) ? step.status : 'pending' }));
}

// Progress text counts only milestones the agent reported with evidence.
export function journeySummary(steps, status) {
  const total = steps.length, observed = steps.filter(step => step.status === 'completed').length;
  if (!total || ['queued', 'pending', 'not_run'].includes(status)) return { observed, total, text: '' };
  if (journeyStreaming(status)) {
    const current = steps.find(step => step.status === 'running');
    return { observed, total, text: current ? `${observed}/${total} · ${current.title}` : `${observed}/${total}` };
  }
  const stopped = steps.find(step => step.status === 'failed') || steps.find(step => step.status === 'blocked');
  return stopped ? { observed, total, text: stopped.title, status: stopped.status } : { observed, total, text: `${observed}/${total} observed` };
}

export function journeyElapsed(startedAt, now) {
  const start = Date.parse(startedAt || '');
  if (!Number.isFinite(start)) return '';
  const seconds = Math.max(0, Math.floor((now - start) / 1000)), pad = value => String(value).padStart(2, '0');
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}` : `${pad(minutes)}:${pad(seconds % 60)}`;
}

export const journeyQueueLabel = reason => own(QUEUES, reason) || 'Waiting for a browser';

// Graph summaries carry only actionCount and lastAction; the watch dialog's run progress keeps the full list.
export function journeyActions(progress) {
  const items = Array.isArray(progress?.actions) ? progress.actions : progress?.lastAction ? [progress.lastAction] : [];
  return { items, count: progress?.actionCount ?? items.length };
}

// The controller marks a final check on an end state the journey never reached; it is context, never a failure.
export const journeyCheckFailed = check => check?.passed === false && check.reached !== false;
export function journeyCheckState(check) {
  if (check?.reached === false) return { label: 'Not reached', variant: 'outline' };
  if (check?.passed === true) return { label: 'Passed', variant: 'outline' };
  return check?.passed === false ? { label: 'Failed', variant: 'destructive' } : { label: 'Not checked', variant: 'outline' };
}

export function journeyLastAction(progress) {
  const last = progress?.lastAction || progress?.actions?.at(-1);
  return last ? { ...last, count: progress.actionCount ?? progress.actions?.length ?? 0 } : null;
}

export const browserActionLabel = type => own(ACTIONS, type) || String(type || 'Action').replaceAll('_', ' ');
export const browserActionError = code => own(ACTION_ERRORS, code);
// A failed action always names its failure in text, not only with an icon.
export const browserActionFailure = action => action?.status === 'failed' ? browserActionError(action.errorCode) || browserRunLabel('failed') : '';

export function browserBlockers(result, steps = []) {
  return (Array.isArray(result?.blockers) ? result.blockers : []).map(blocker => ({ kind: own(BLOCKERS, blocker.kind) || 'Blocker', step: steps.find(step => step.id === blocker.stepId)?.title || '', evidence: String(blocker.evidence || '') }));
}

export function browserFrameLabel({ status, runId, image = false, error = '', fresh = false, streaming = journeyStreaming(status) }) {
  if (image) return streaming ? error ? 'Reconnecting' : fresh ? 'Live' : 'Waiting for frame' : 'Last frame';
  if (streaming) return error ? 'Reconnecting' : status === 'running' ? 'Opening browser…' : browserRunLabel(status);
  if (!runId) return status === 'needs_review' ? 'Review to run' : browserRunLabel(status);
  if (error) return error;
  return journeyActive(status) ? browserRunLabel(status) : 'No browser frame';
}

// The controller's status is the verdict; the list only orders by it.
const ATTENTION = ['failed', 'blocked', 'needs_review'];
const journeyPriority = status => ATTENTION.includes(status) ? ATTENTION.indexOf(status) : ATTENTION.length;

// Finished runs lead with what needs attention; active runs keep their queue order.
export function orderJourneys(items, run) {
  const entries = items.map(item => { const state = browserCaseState(item, [run]); return { item, status: state.status, label: state.label, result: run.results?.find(value => value.caseId === item.id) }; });
  if (['queued', 'running'].includes(run.status)) return entries;
  return entries.map((entry, index) => ({ entry, index, rank: journeyPriority(entry.status) })).sort((a, b) => a.rank - b.rank || a.index - b.index).map(({ entry }) => entry);
}

export function browserConcurrencyLabel(run) {
  if (!Number.isInteger(run?.concurrency) || !Number.isInteger(run.effectiveConcurrency) || run.effectiveConcurrency >= run.concurrency) return '';
  const reason = own(LIMITS, run.concurrencyLimit);
  return `${run.effectiveConcurrency} of ${run.concurrency} browsers${reason ? ` · ${reason}` : ''}`;
}

// Reviewed journeys lead; step-less legacy cases and drafts stay available but grouped.
export function stageJourneyGroups(cases, runs = []) {
  const journeys = cases.filter(item => (!item.needsReview && item.steps?.length > 0) || journeyActive(browserCaseState(item, runs).status));
  return { journeys, others: cases.filter(item => !journeys.includes(item)) };
}

// Case IDs start with a letter or digit, so '!' requests can never collide with a case.
export const JOURNEY_GENERATE_REQUEST = '!generate';
export const journeyRunRequest = caseId => `!run:${caseId}`;
// A graph Generate request passes the same gates as the toolbar Generate button.
export const generateRequestDialog = ({ disabled = false, unavailable = false, validTarget = false }) => disabled || unavailable ? null : validTarget ? 'generate' : 'settings';
export function journeyRequest(value = '') {
  if (value === 'new') return { kind: 'new', caseId: '' };
  if (value === JOURNEY_GENERATE_REQUEST) return { kind: 'generate', caseId: '' };
  if (value.startsWith('!run:')) return { kind: 'run', caseId: value.slice(5) };
  return { kind: value && !value.startsWith('!') ? 'case' : '', caseId: value.startsWith('!') ? '' : value };
}

export function browserRunTitle(run) {
  if (run.mode === 'discover') return 'Explore product';
  const summaries = run.caseSummaries || [];
  const count = run.caseIds?.length || summaries.length;
  const name = summaries.find(item => item.name?.trim())?.name;
  if (name) return count > 1 ? `${name} + ${count - 1}` : name;
  return count ? `${count} ${count === 1 ? 'test' : 'tests'}` : 'Test run';
}
