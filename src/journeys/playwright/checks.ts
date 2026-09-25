// Check semantics shared by the Playwright journey fixture and its reporter; discovery proposes checks in these terms
// (integrations/browser-use/journey_steps.py validates them).
import type { BrowserCase, CompareNumberCheck, JourneyStep, MilestoneCheck, TextCheck } from '../../business/browser-cases.ts';

export type { JourneyStep, TextCheck };
/** A reviewed milestone check or final assertion, as src/business/browser-cases.ts validates it. */
export type Check = MilestoneCheck;
export type Operator = CompareNumberCheck['op'];
/** How a check fared on the page: observed is the number it read. */
export type Evaluation = { passed: boolean; observed?: number; error?: string };
export type EvaluatedCheck<C extends Check = Check> = C & Evaluation;
/** The first number after a label, and how far after it that number starts. */
export type Reading = { value: number; gap: number };
/** Numbers read-number checks captured so far, by name. */
export type Captures = Record<string, number>;
/** The approved case snapshot a journey runs against, as far as it reads it: the controller writes it from the reviewed case. */
export type ApprovedCase = Pick<BrowserCase, 'id' | 'name' | 'goal'> & Partial<Pick<BrowserCase, 'steps' | 'assertions' | 'preconditions' | 'expectedOutcomes'>>;
/** The snapshot as a journey process reads it back from its file: its text fields and lists, which the controller validated. */
export function approvedCase(value: unknown): ApprovedCase {
  const snapshot = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!snapshot || (['id', 'name', 'goal'] as const).some(field => typeof snapshot[field] !== 'string')
    || (['steps', 'assertions', 'preconditions', 'expectedOutcomes'] as const).some(field => snapshot[field] !== undefined && !Array.isArray(snapshot[field]))) throw new Error('The approved case snapshot is unreadable.');
  return snapshot as ApprovedCase;
}
/** What the fixture reports to the reporter over the run's event channel, tagged with the case ID. */
export type FixtureEvent =
  | { type: 'journey-stop'; error: string }
  | { type: 'frame'; data: string; timestamp: number }
  | { type: 'journey-step'; stepId: string; status: 'running' | 'completed' | 'failed'; evidence?: string; checks?: EvaluatedCheck[] }
  | { type: 'assertions'; assertions: { type: TextCheck['type']; value: string; passed: boolean }[] };

// The fixture's own steps: their Playwright calls are never journey actions.
export const STEPS = { checks: 'Perpetual reviewed checks', signIn: 'Perpetual sign-in' };
export const OPERATORS: Record<Operator, (a: number, b: number) => boolean> = { '<': (a, b) => a < b, '>': (a, b) => a > b, '=': (a, b) => a === b, '!=': (a, b) => a !== b };
// A sign or currency symbol must touch its digits, so "Credits - 120" reads 120.
const NUMBER = /(?<![\d.,])([-−]?)(?:[$€£]\s?)?(\d{1,3}(?:,\d{3})+(?![\d,])|\d+)(\.\d+)?/g;
const squash = (value: string) => value.split(/\s+/).filter(Boolean).join(' ');
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The first number after a visible label, { value, gap }, or null: 1,240, 1240.5, -3 or $12.00.
 * adjacent: only separators may sit between them, so an ancestor's sibling text is never read.
 */
export function numberAfter(text: string, label: string, adjacent = false): Reading | null {
  text = squash(text); label = squash(label);
  const found = label ? new RegExp(escape(label), 'iu').exec(text) : null;
  if (!found) return null;
  const end = found.index + found[0].length;
  NUMBER.lastIndex = end;
  const match = NUMBER.exec(text);
  if (!match || adjacent && /[\p{L}\p{N}]/u.test(text.slice(end, match.index))) return null;
  const [, sign, whole, fraction] = match;
  return { value: Number(`${sign ? '-' : ''}${whole.replaceAll(',', '')}${fraction || ''}`), gap: match.index - end };
}

const originOf = (url: string) => { try { const { protocol, origin } = new URL(url); return ['http:', 'https:'].includes(protocol) ? origin : null; } catch { return null; } };
export const sameOrigin = (url: string, other: string) => Boolean(originOf(url)) && originOf(url) === originOf(other);
export const navigationAllowed = (url: string, allowed: ReadonlySet<string | null>) => url === 'about:blank' || allowed.has(originOf(url));

// Stripe pages accept input only in test mode. A document is judged before it loads, so
// only its path can show test mode here: cs_test_ or /test_, never a live marker. Nothing live loads in any frame.
const stripePath = (url: string) => { try { const { hostname, pathname } = new URL(url); return hostname === 'stripe.com' || hostname.endsWith('.stripe.com') ? pathname : null; } catch { return null; } };
export const stripeLive = (url: string) => /cs_live_|\/live_/.test(stripePath(url) ?? '');
export const paymentAllowed = (url: string) => stripePath(url) === null || !stripeLive(url) && /cs_test_|\/test_/.test(stripePath(url) ?? '');

const LABELS: Partial<Record<string, string>> = { 'url-contains': 'URL contains', 'text-visible': 'Text visible', 'text-absent': 'Text absent' };
const textCheck = (check: Check): check is TextCheck => Boolean(LABELS[check.type]);
/** One evaluated check in words, for milestone evidence. */
export function checkText(check: Check & { observed?: number }, captures: Captures = {}) {
  if (textCheck(check)) return `${LABELS[check.type]} “${squash(check.value)}”`;
  const value = Number.isFinite(check.observed) ? ` ${check.observed}` : '';
  if (check.type === 'read-number') return `${squash(check.label)}${value}`;
  return `${squash(check.label)}${value} ${check.op} ${check.than}${Number.isFinite(captures[check.than]) ? ` ${captures[check.than]}` : ''}`;
}
