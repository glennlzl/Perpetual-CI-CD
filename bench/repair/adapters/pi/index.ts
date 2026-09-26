// The pi adapter: pi-coding-agent's SDK session runs in the runner's process against the gateway, while every file
// operation and command of its tools runs in the bench box (session.ts, operations.ts). pi is this folder's own
// dependency, pinned in its package.json and lockfile and installed with `npm ci --prefix adapters/pi`; it loads only
// when an attempt runs, so the runner can list pi, and skip it, where it is not installed.
import { readFile } from 'node:fs/promises';
import type { Adapter } from '../../harness.ts';

const PI = '@earendil-works/pi-coding-agent';
const INSTALL = 'run npm ci --prefix adapters/pi in bench/repair';
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const manifest = (path: string): Promise<Record<string, unknown>> => readFile(new URL(path, import.meta.url), 'utf8')
  .then(text => { const parsed: unknown = JSON.parse(text); return isRecord(parsed) ? parsed : {}; }).catch(() => ({}));
/** The version this folder pins, and the one installed beside it, if any. */
async function versions() {
  const [own, installed] = await Promise.all([manifest('./package.json'), manifest(`./node_modules/${PI}/package.json`)]);
  const pinned = isRecord(own.dependencies) && typeof own.dependencies[PI] === 'string' ? own.dependencies[PI] : 'unknown';
  return { pinned, installed: typeof installed.version === 'string' ? installed.version : null };
}
const found = await versions();

export const adapter: Adapter = {
  key: 'pi', version: `${PI}@${found.installed ?? `${found.pinned} (not installed)`}`, inBox: false,
  async available() {
    const { pinned, installed } = await versions();
    if (!installed) return `pi is not installed: ${INSTALL}.`;
    return installed === pinned ? null : `pi ${installed} is installed, not the pinned ${pinned}: ${INSTALL}.`;
  },
  async runAttempt(input) { const { runPi } = await import('./session.ts'); return runPi(input); },
};
