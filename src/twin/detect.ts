import { posix } from 'node:path';
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
export interface DetectionEvidence { files?: string[]; packages?: string[]; env?: string[]; apps?: DetectedApp[]; install?: { directory?: string | null; command: string } }
/** A proposed twin config, before validation. */
export interface DetectedConfig { services: Record<string, JsonObject>; apps: Record<string, Omit<TwinApp, 'env'>>; install?: TwinInstall }

/**
 * files: repository-relative paths; packages: dependency names; env: variable names;
 * apps: [{ id, directory, build?, start, port }] from the repository scan; install: { directory, command }
 * that those apps share, if any. A service found by a file gets that file's directory as its `directory` option,
 * and a found service leaves out the services it `includes`.
 */
export function detectTwinConfig({ files = [], packages = [], env = [], apps = [], install }: DetectionEvidence = {}, { services = registry }: { services?: TwinServices } = {}): DetectedConfig {
  const config: DetectedConfig = { services: {}, apps: {} };
  const sorted = [...files].sort();
  for (const service of Object.values(services)) {
    const detect = service.detect ?? {};
    const file = sorted.find(path => (detect.files ?? []).some(pattern => fileMatches(pattern, path)));
    const found = file || packages.some(name => (detect.packages ?? []).some(pattern => matches(pattern, name)))
      || env.some(name => (detect.env ?? []).some(pattern => matches(pattern, name)));
    if (found) config.services[service.id] = file ? { directory: posix.dirname(file) } : {};
  }
  // A service that already includes another, e.g. a local stack with its own database, supplies it.
  for (const id of Object.keys(config.services)) for (const included of services[id].includes ?? []) delete config.services[included];
  for (const app of apps) {
    const id = appId(app.id);
    if (!id || !app.start || !Number.isInteger(app.port) || Object.hasOwn(config.apps, id) || Object.hasOwn(config.services, id) || (install && id === INSTALL)) continue;
    config.apps[id] = { directory: app.directory || '.', ...(app.build ? { build: app.build } : {}), start: app.start, port: app.port };
  }
  if (install) config.install = { directory: install.directory || '.', command: install.command };
  return config;
}
