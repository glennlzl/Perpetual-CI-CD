// Check semantics shared by the Playwright journey fixture and its reporter. They match the browser-use runner's
// (integrations/browser-use/journey_steps.py and runner.py), so both engines read a reviewed check the same way.

// The fixture's own steps: their Playwright calls are never journey actions.
export const STEPS = { checks: 'Perpetual reviewed checks', signIn: 'Perpetual sign-in' };
export const OPERATORS = { '<': (a, b) => a < b, '>': (a, b) => a > b, '=': (a, b) => a === b, '!=': (a, b) => a !== b };
// A sign or currency symbol must touch its digits, so "Credits - 120" reads 120.
const NUMBER = /(?<![\d.,])([-−]?)(?:[$€£]\s?)?(\d{1,3}(?:,\d{3})+(?![\d,])|\d+)(\.\d+)?/g;
const squash = value => value.split(/\s+/).filter(Boolean).join(' ');
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The first number after a visible label, { value, gap }, or null: 1,240, 1240.5, -3 or $12.00.
 * adjacent: only separators may sit between them, so an ancestor's sibling text is never read.
 */
export function numberAfter(text, label, adjacent = false) {
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

const originOf = url => { try { const { protocol, origin } = new URL(url); return ['http:', 'https:'].includes(protocol) ? origin : null; } catch { return null; } };
export const sameOrigin = (url, other) => Boolean(originOf(url)) && originOf(url) === originOf(other);
export const navigationAllowed = (url, allowed) => url === 'about:blank' || allowed.has(originOf(url));

// Stripe pages accept input only in test mode (runner.py payment_allowed). A document is judged before it loads, so
// only its path can show test mode here: cs_test_ or /test_, never a live marker. Nothing live loads in any frame.
const stripePath = url => { try { const { hostname, pathname } = new URL(url); return hostname === 'stripe.com' || hostname.endsWith('.stripe.com') ? pathname : null; } catch { return null; } };
export const stripeLive = url => /cs_live_|\/live_/.test(stripePath(url) ?? '');
export const paymentAllowed = url => stripePath(url) === null || !stripeLive(url) && /cs_test_|\/test_/.test(stripePath(url));

const LABELS = { 'url-contains': 'URL contains', 'text-visible': 'Text visible', 'text-absent': 'Text absent' };
/** One evaluated check in words, for milestone evidence. */
export function checkText(check, captures = {}) {
  if (LABELS[check.type]) return `${LABELS[check.type]} “${squash(check.value)}”`;
  const value = Number.isFinite(check.observed) ? ` ${check.observed}` : '';
  if (check.type === 'read-number') return `${squash(check.label)}${value}`;
  return `${squash(check.label)}${value} ${check.op} ${check.than}${Number.isFinite(captures[check.than]) ? ` ${captures[check.than]}` : ''}`;
}
