import { randomUUID } from 'node:crypto';
import { businessSourceContext, redactBusinessText } from './discovery.mjs';

const CASE_KEYS = new Set(['id', 'name', 'goal', 'steps', 'isolation', 'preconditions', 'expectedOutcomes', 'assertions', 'selected', 'needsReview', 'evidence']);
const CHECKS = new Set(['url-contains', 'text-visible', 'text-absent']);
const STEP_CHECKS = new Set([...CHECKS, 'read-number', 'compare-number']);
const CAPTURE = /^[a-z][A-Za-z0-9]{0,39}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function text(value, label, max, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error(`${label} must contain ${empty ? 0 : 1}–${max} characters.`);
  return value.trim();
}
function keys(value, allowed, label) {
  if (!object(value)) throw new Error(`${label} must be an object.`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unsupported ${label} field: ${key}`);
}
function texts(value, label, { required = false } = {}) {
  if (!Array.isArray(value) || value.length > 20 || (required && !value.length)) throw new Error(`${label} must contain ${required ? 1 : 0}–20 items.`);
  return value.map(item => text(item, label, 2000));
}
function evidence(value) {
  if (!Array.isArray(value) || value.length > 40) throw new Error('Evidence must contain at most 40 source references.');
  return value.map(item => {
    keys(item, new Set(['path', 'line']), 'evidence');
    const name = text(item.path, 'Evidence path', 1024);
    if (name.includes('\\') || /^[A-Za-z]:/.test(name) || name.split('/').some(part => !part || part.startsWith('.')) || /(?:^|\/)(?:AGENTS|CLAUDE|GEMINI|SKILL)\.md$|(?:^|\/)(?:secrets?|credentials?)(?:\.|\/|$)|\.(?:pem|key|p12)$/i.test(name)) throw new Error('Evidence must reference a repository source file.');
    if (!Number.isInteger(item.line) || item.line < 1 || item.line > 1000000) throw new Error('Evidence line must be a positive integer.');
    return { path: name, line: item.line };
  });
}

/** The runner evaluates these on the live page; the model never supplies observed values. */
function milestoneChecks(value, captures) {
  if (!Array.isArray(value) || value.length > 6) throw new Error('Provide at most 6 checks per journey step.');
  return value.map(check => {
    if (!object(check) || !STEP_CHECKS.has(check.type)) throw new Error('Unsupported milestone check type.');
    if (CHECKS.has(check.type)) {
      keys(check, new Set(['type', 'value']), 'milestone check');
      return { type: check.type, value: text(check.value, 'Milestone check value', 4000) };
    }
    keys(check, new Set(check.type === 'read-number' ? ['type', 'label', 'name'] : ['type', 'label', 'name', 'op', 'than']), 'milestone check');
    const label = text(check.label, 'Milestone check label', 120);
    if (typeof check.name !== 'string' || !CAPTURE.test(check.name)) throw new Error('Milestone check names start with a lowercase letter and use up to 40 letters or digits.');
    if (check.type === 'read-number') { captures.add(check.name); return { type: check.type, label, name: check.name }; }
    if (!['<', '>', '=', '!='].includes(check.op)) throw new Error('Choose a milestone check comparison: <, >, = or !=.');
    if (typeof check.than !== 'string' || !captures.has(check.than)) throw new Error('A milestone check can only compare with an earlier read-number check.');
    return { type: check.type, label, name: check.name, op: check.op, than: check.than };
  });
}

/** Milestones describe business progress, never executable browser commands. */
function journeySteps(value) {
  if (!Array.isArray(value) || value.length > 12) throw new Error('Provide at most 12 journey steps.');
  const ids = new Set(), captures = new Set();
  return value.map(step => {
    keys(step, new Set(['id', 'title', 'checks']), 'journey step');
    const id = text(step.id, 'Journey step ID', 100);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id) || ids.has(id)) throw new Error('Journey step IDs must be valid and unique within the case.');
    ids.add(id);
    const title = text(step.title, 'Journey step title', 240), checks = milestoneChecks(step.checks ?? [], captures);
    return { id, title, ...(checks.length ? { checks } : {}) };
  });
}

/** New or edited reviewed cases are journeys; a byte-identical stored legacy case stays runnable. */
export function assertReviewedJourneys(cases, stored = []) {
  const unchanged = item => JSON.stringify({ ...item, selected: false });
  const previous = new Map(stored.map(item => [item.id, unchanged(item)]));
  for (const item of cases) {
    if (item.needsReview || (item.steps.length >= 2 && item.steps.length <= 12) || previous.get(item.id) === unchanged(item)) continue;
    throw new Error(`Add 2–12 milestones before approving “${item.name}”.`);
  }
}

/** Goal-based cases. Empty checks are allowed but cannot yield an independently verified pass. */
export function validateBrowserCases(cases, { draft = true } = {}) {
  if (!Array.isArray(cases) || cases.length > 60) throw new Error('Provide at most 60 browser cases.');
  const ids = new Set();
  return cases.map(item => {
    keys(item, CASE_KEYS, 'browser case');
    const id = text(item.id ?? randomUUID(), 'Case ID', 200);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) throw new Error('Invalid case ID.');
    if (ids.has(id)) throw new Error('Duplicate browser case ID.');
    ids.add(id);
    for (const field of ['selected', 'needsReview']) if (item[field] !== undefined && typeof item[field] !== 'boolean') throw new Error(`${field} must be a boolean.`);
    const selected = item.selected ?? false, needsReview = item.needsReview ?? draft;
    if (selected && needsReview) throw new Error('Review this browser case before selecting it.');
    const isolation = item.isolation ?? 'shared';
    if (!['shared', 'isolated'].includes(isolation)) throw new Error('Choose shared or isolated test data.');
    if (!Array.isArray(item.assertions ?? []) || (item.assertions ?? []).length > 20) throw new Error('Provide at most 20 assertions.');
    const assertions = (item.assertions ?? []).map(check => {
      keys(check, new Set(['type', 'value']), 'assertion');
      if (!CHECKS.has(check.type)) throw new Error('Unsupported browser assertion type.');
      return { type: check.type, value: text(check.value, 'Assertion value', 2000) };
    });
    const result = {
      id, name: text(item.name, 'Case name', 120), goal: text(item.goal, 'Business goal', 4000),
      steps: journeySteps(item.steps ?? []), isolation,
      preconditions: texts(item.preconditions ?? [], 'Preconditions'),
      expectedOutcomes: texts(item.expectedOutcomes, 'Expected outcomes', { required: true }),
      assertions, selected, needsReview, evidence: evidence(item.evidence ?? []),
    };
    if (Buffer.byteLength(JSON.stringify(result)) > 65536) throw new Error('Browser case exceeds 64 KiB.');
    return result;
  });
}

/** Supplied files and source lines are data, not Agent instructions. */
export async function browserDiscoveryContext({ repoPath, scope = '', requirements = '' } = {}) {
  const source = repoPath ? await businessSourceContext(repoPath, { scope: `${scope}\n${requirements}` }) : { files: [], warnings: [] };
  return JSON.stringify({
    scope: redactBusinessText(text(scope, 'Scope', 4000, true)),
    requirements: redactBusinessText(text(requirements, 'Requirements', 20000, true)),
    ...source,
  });
}

/**
 * Child/model output cannot approve itself or claim nonexistent source evidence. A citation to a
 * line that was not supplied is dropped, and an invalid journey is omitted with its reason, so one
 * bad proposal never discards a whole paid discovery. When no proposed journey is valid, every
 * omission is still returned so the caller can keep the reasons.
 */
export function discoveredBrowserCases(cases, sourceContext = '{}') {
  if (!Array.isArray(cases) || cases.length > 4) throw new Error('Agent discovery must return at most four complete business journeys.');
  const context = JSON.parse(sourceContext);
  const supplied = new Map((context.files || []).map(file => [file.path, new Set(file.source.split('\n').map(line => Number(line.match(/^(\d+):\s*\S/)?.[1])).filter(Number.isFinite))]));
  const cited = ref => object(ref) && supplied.get(ref.path)?.has(ref.line) === true;
  const ids = new Set(), accepted = [], omitted = [];
  for (const proposal of cases) {
    try {
      const candidate = object(proposal) && Array.isArray(proposal.evidence) ? { ...proposal, evidence: proposal.evidence.filter(cited) } : proposal;
      const [item] = validateBrowserCases([{ ...candidate, selected: false, needsReview: true, isolation: 'shared' }], { draft: true });
      if (ids.has(item.id)) throw new Error('Duplicate browser case ID.');
      if (item.steps.length < 2) throw new Error('Generated journeys need at least two ordered business steps.');
      if (JSON.stringify(item).includes('[REDACTED]')) throw new Error('Redacted source content cannot be used as test input.');
      ids.add(item.id);
      accepted.push(item);
    } catch (error) {
      const plain = (value, max) => String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
      omitted.push({ name: typeof proposal?.name === 'string' && plain(proposal.name, 120) || 'Untitled journey', reason: plain(error.message, 200) });
    }
  }
  return { cases: accepted, omitted };
}

/** A drafted case must be acceptable: fails with every reason when no proposed journey is valid. */
export function validateDiscoveredBrowserCases(cases, sourceContext) {
  const { cases: accepted, omitted } = discoveredBrowserCases(cases, sourceContext);
  if (!accepted.length && omitted.length) throw new Error(omitted.map(item => item.reason).join(' '));
  return accepted;
}
