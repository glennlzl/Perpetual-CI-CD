import { posix } from 'node:path';
import { NODE_CURRENT, NODE_LTS } from './compose.ts';
import { INSTALL } from './config.ts';
import { services as registry } from './registry.ts';
import type { JsonObject, TwinApp, TwinInstall } from './config.ts';
import type { Pattern, TwinServices } from './registry.ts';

// Proposes a twin config from repository evidence. Each service's own `detect`
// decides whether it applies; nothing here knows any product.

const matches = (pattern: Pattern, value: string) => pattern instanceof RegExp ? pattern.test(value) : pattern === value;
const fileMatches = (pattern: Pattern, file: string) => pattern instanceof RegExp ? pattern.test(file) : file === pattern || file.endsWith(`/${pattern}`);
/** A twin app's id for a repository scan service id, e.g. service:web -> service-web. */
export const appId = (value: unknown) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+|-+$/g, '');

/** Variable names declared in a .env-style file; values are never returned. */
export const envNames = (text: unknown) => [...new Set(String(text).split(/\r?\n/)
  .map(line => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1]).filter(name => name !== undefined))];

/** An app the repository scan found: its scan service id, directory and commands. */
export interface DetectedApp { id: string; directory?: string; build?: string; start?: string; port: number }
export interface DetectionEvidence { files?: string[]; packages?: string[]; env?: string[]; apps?: DetectedApp[]; install?: { directory?: string | null; command: string }; node?: number }
/** A proposed twin config, before validation. */
export interface DetectedConfig { services: Record<string, JsonObject>; apps: Record<string, Omit<TwinApp, 'env'>>; install?: TwinInstall; node?: number }

/**
 * files: repository-relative paths; packages: dependency names; env: variable names;
 * apps: [{ id, directory, build?, start, port }] from the repository scan; install: { directory, command }
 * that those apps share, if any; node: the Node.js major the repository asks for, if any. A service found by a file gets
 * that file's directory as its `directory` option, and a found service leaves out the services it `includes`.
 */
export function detectTwinConfig({ files = [], packages = [], env = [], apps = [], install, node }: DetectionEvidence = {}, { services = registry }: { services?: TwinServices } = {}): DetectedConfig {
  const config: DetectedConfig = { services: {}, apps: {} };
  const sorted = [...files].sort();
  for (const service of Object.values(services)) {
    const detect = service.detect ?? {};
    const file = sorted.find(path => (detect.files ?? []).some(pattern => fileMatches(pattern, path)));
    const found = file || packages.some(name => (detect.packages ?? []).some(pattern => matches(pattern, name)))
      || env.some(name => (detect.env ?? []).some(pattern => matches(pattern, name)));
    if (found) config.services[service.id] = { ...(file ? { directory: posix.dirname(file) } : {}), ...detect.options?.({ packages, env }) };
  }
  // A service that already includes another, e.g. a local stack with its own database, supplies it.
  for (const id of Object.keys(config.services)) for (const included of services[id].includes ?? []) delete config.services[included];
  for (const app of apps) {
    const id = appId(app.id);
    if (!id || !app.start || !Number.isInteger(app.port) || Object.hasOwn(config.apps, id) || Object.hasOwn(config.services, id) || (install && id === INSTALL)) continue;
    config.apps[id] = { directory: app.directory || '.', ...(app.build ? { build: app.build } : {}), start: app.start, port: app.port };
  }
  if (install) config.install = { directory: install.directory || '.', command: install.command };
  if (node !== undefined) config.node = node;
  return config;
}

// A version as one number, so a range is a list of [from, to) spans: major, minor and patch, each below a million.
const PART = 1e6;
const at = (major: number, minor = 0, patch = 0) => (major * PART + Math.min(minor, PART - 1)) * PART + Math.min(patch, PART - 1);
const majorAt = (version: number) => Math.floor(version / PART / PART);

type Span = [from: number, to: number];

/** The versions one comparator of a semver range admits, such as >=20, ^22.11, ~20.1, 22.x or 24; null when it is none. */
function span(comparator: string): Span | null {
  const match = /^(>=|<=|>|<|=|\^|~)?v?(\d+|[xX*])(?:\.(\d+|[xX*])(?:\.(\d+|[xX*])(?:-[\w.-]+)?(?:\+[\w.-]+)?)?)?$/.exec(comparator);
  if (!match) return null;
  const [, operator = '=', ...parts] = match, numbers: number[] = [];
  for (const part of parts) { if (part === undefined || !/^\d+$/.test(part)) break; numbers.push(Number(part)); }
  // A wildcard, as *, admits every version.
  if (!numbers.length) return ['>', '<'].includes(operator) ? [0, 0] : [0, Infinity];
  const [major, minor = 0, patch = 0] = numbers, from = at(major, minor, patch);
  // The first version after every one the comparator names, as 22.1 names every 22.1.x.
  const after = numbers.length === 1 ? at(major + 1) : numbers.length === 2 ? at(major, minor + 1) : at(major, minor, patch + 1);
  const spans: Record<string, Span> = { '=': [from, after], '>=': [from, Infinity], '>': [after, Infinity], '<': [0, from], '<=': [0, after],
    '^': [from, at(major + 1)], '~': [from, numbers.length === 1 ? at(major + 1) : at(major, minor + 1)] };
  return spans[operator] ?? null;
}

/** The versions a semver range admits, a span for each of its || alternatives that admits any; null when it is no range. */
function rangeSpans(range: string): Span[] | null {
  const spans: Span[] = [];
  for (const alternative of range.split('||')) {
    const words = alternative.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean);
    // A hyphen range, 18 - 20, admits every version from the first through the last it names.
    const comparators = words.length === 3 && words[1] === '-' ? [`>=${words[0]}`, `<=${words[2]}`] : words;
    const parts = comparators.map(span).filter((part): part is Span => part !== null);
    if (!comparators.length || parts.length < comparators.length) return null;
    const from = Math.max(...parts.map(([start]) => start)), to = Math.min(...parts.map(([, end]) => end));
    if (from < to) spans.push([from, to]);
  }
  return spans;
}

/**
 * The Node.js major a version or range asks for: the newest maintained major it admits, an LTS (NODE_LTS) before the
 * current release (NODE_CURRENT), so a range such as >=18 or >=25 never runs on an end-of-life major. Else the newest
 * released major it admits, one that was an LTS before an odd one, so an odd major runs only when nothing else is
 * admitted, as for ^25; a range above every release gets the first major it admits. Undefined when it names no version,
 * as lts/* or * do, or admits none from 18.
 */
export function nodeMajor(value: unknown) {
  const spans = typeof value === 'string' && value.length <= 200 && /\d/.test(value) ? rangeSpans(value) : null;
  if (!spans?.length) return undefined;
  const admits = (major: number) => spans.some(([from, to]) => from < at(major + 1) && to > at(major));
  const maintained = [...NODE_LTS, NODE_CURRENT].find(admits);
  if (maintained !== undefined) return maintained;
  const released = Array.from({ length: NODE_CURRENT - 17 }, (_, index) => NODE_CURRENT - index).filter(admits);
  const major = released.find(item => item % 2 === 0) ?? released[0] ?? majorAt(Math.min(...spans.map(([from]) => from)));
  return major >= 18 && major <= 99 ? major : undefined;
}
