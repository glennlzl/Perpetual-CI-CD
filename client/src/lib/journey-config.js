export const MAX_CASES = 60;
// The controller keeps at most MAX_CASES and discovery returns up to four journeys.
export const MAX_DISCOVERED = 4;
export const DEFAULT_JOURNEY_TIMEOUT = 900;
const parse = value => { try { return new URL(value); } catch { return null; } };
export const validUrl = value => ['http:', 'https:'].includes(parse(value)?.protocol);
export const sameUrl = (left, right) => validUrl(left) && validUrl(right) && parse(left).href === parse(right).href;

const VERCEL_ALIAS = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.vercel\.app$/i;
const BRANCH = /^[\w./-]{1,255}$/;
// Only literal branch names reported by the scan or the sandbox record; nothing is inferred from a URL.
const branchesOf = values => [...new Set((Array.isArray(values) ? values : [values]).filter(value => typeof value === 'string' && BRANCH.test(value)))];
// Scanned Vercel preview aliases are real application URLs; account access stays unverified.
export function previewTargets(scan) {
  return (Array.isArray(scan?.nodes) ? scan.nodes : [])
    .filter(node => node?.provider === 'Vercel' && typeof node.previewAlias === 'string' && VERCEL_ALIAS.test(node.previewAlias))
    .map(node => {
      const branches = branchesOf(node.deployBranches);
      return { url: `https://${node.previewAlias.toLowerCase()}`, label: String(node.label || node.projectName || node.previewAlias), ...(branches.length ? { branches } : {}) };
    });
}
// The one wording for a URL that deploys another branch than the scanned one.
export const branchMismatchNote = (branches, scanned) => `Deploys ${branches.join(', ')}, not ${scanned}`;
// Target suggestions come only from a ready sandbox's services and scanned previews; nothing is guessed.
// Sandbox services lead; within each group a URL deploying another branch than the scanned one follows.
export function targetSuggestions({ environment, previews = [], branch = '' } = {}) {
  const services = environment?.status === 'ready' && Array.isArray(environment.services) ? environment.services : [];
  const tag = (item, values, sandbox) => {
    const branches = branchesOf(values);
    const mismatch = Boolean(branch && branches.length && !branches.includes(branch));
    return { ...item, branches, mismatch, ...(mismatch ? { scannedBranch: branch } : {}), sandbox };
  };
  const items = [...services.map(service => tag({ url: service?.url, label: String(service?.name || service?.id || 'Sandbox') }, environment.sourceBranch, true)), ...previews.map(preview => tag(preview, preview?.branches, false))];
  const seen = new Set();
  return items.filter(item => {
    if (!validUrl(item?.url)) return false;
    const key = parse(item.url).href;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).map((item, index) => ({ item, index }))
    .sort((a, b) => Number(b.item.sandbox) - Number(a.item.sandbox) || Number(a.item.mismatch) - Number(b.item.mismatch) || a.index - b.index)
    .slice(0, 8).map(({ item: { sandbox: _sandbox, ...item } }) => item);
}

// Regeneration offers to replace only step-less legacy cases and unreviewed drafts.
export const replaceableCase = item => Boolean(item.needsReview) || !item.steps?.length;
export const defaultReplaceIds = cases => cases.filter(replaceableCase).map(item => item.id);
export const generateRoom = (total, replacing) => MAX_CASES - total + replacing;
// Generate needs room for a full discovery result, or the controller would drop journeys silently.
export function generateError(total, replacing) {
  const missing = MAX_DISCOVERED - generateRoom(total, replacing);
  return missing > 0 ? `Select ${missing} more ${missing === 1 ? 'test' : 'tests'} to replace.` : '';
}
export const journeyTimeoutMinutes = config => String(Number(((config.journeyTimeoutSeconds ?? DEFAULT_JOURNEY_TIMEOUT) / 60).toFixed(2)));

function originError(value) {
  const url = parse(value);
  if (!url) return 'Enter an HTTPS origin.';
  if (url.protocol !== 'https:') return 'Use HTTPS.';
  if (url.username || url.password) return 'Remove the credentials.';
  return url.pathname !== '/' || url.search || url.hash || /[?#]/.test(value) ? 'Remove the path and query.' : '';
}
function endpointError(value, target) {
  const url = /^[a-z][a-z0-9+.-]*:/i.test(value) ? parse(value) : null;
  if (!url) return 'Enter an absolute URL.';
  if (!['http:', 'https:'].includes(url.protocol)) return 'Use HTTP or HTTPS.';
  if (url.username || url.password) return 'Remove the credentials.';
  if (!target || url.hostname !== target.hostname) return 'Use the target host.';
  if (url.search || url.hash || /[?#]/.test(value)) return 'Remove the query.';
  // Discovery allows any POST that starts with this URL, so it must not cover an origin or the target page's parents.
  const covers = url.origin === target.origin && target.pathname.startsWith(url.pathname) && (url.pathname.endsWith('/') || url.pathname !== target.pathname);
  return url.pathname === '/' || covers ? 'Use a specific endpoint path.' : '';
}
function list(values, check, normalize, limit, noun) {
  const entries = values.map(value => value.trim()), seen = new Set(), items = [];
  const errors = entries.map(value => {
    if (!value) return '';
    const error = check(value);
    if (error) return error;
    const normal = normalize(value);
    if (seen.has(normal)) return `Duplicate ${noun}.`;
    seen.add(normal); items.push(normal); return '';
  });
  return { items, errors, list: entries.filter(Boolean).length > limit ? `Use at most ${limit} ${noun === 'origin' ? 'origins' : 'endpoints'}.` : '' };
}

// Provider origins are run-only navigation targets; discovery stays on the application origin.
export function validateTestSettings({ targetUrl, externalOrigins = [], authEndpoints = [], timeoutMinutes }) {
  const target = validUrl(targetUrl.trim()) ? parse(targetUrl.trim()) : null;
  const origins = list(externalOrigins, originError, value => parse(value).origin, 10, 'origin');
  const endpoints = list(authEndpoints, value => endpointError(value, target), value => parse(value).href, 3, 'endpoint');
  const minutes = String(timeoutMinutes).trim() ? Number(timeoutMinutes) : NaN, seconds = Math.round(minutes * 60);
  const errors = { targetUrl: target ? '' : 'Enter an HTTP or HTTPS target URL.', externalOrigins: origins.errors, externalOriginsList: origins.list, authEndpoints: endpoints.errors, authEndpointsList: endpoints.list, timeout: Number.isFinite(seconds) && seconds >= 60 && seconds <= 1800 ? '' : 'Use 1–30 minutes.' };
  const valid = !errors.targetUrl && !errors.externalOriginsList && !errors.authEndpointsList && !errors.timeout && [...origins.errors, ...endpoints.errors].every(error => !error);
  return { valid, errors, values: { targetUrl: targetUrl.trim(), externalOrigins: origins.items, authEndpoints: endpoints.items, journeyTimeoutSeconds: seconds } };
}
