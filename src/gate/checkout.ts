// A local checkout a gate builds a twin from. A twin copies the checkout as it is on disk, so a commit status for a
// commit holds only when the checkout is at that commit with nothing the copy would take beside it.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { snapshotKeeps } from '../environments/plans.ts';

const exec = promisify(execFile);
// Read-only Git queries: no fetch, no lock, no prompt.
const git = (path: string, args: string[]) => exec('git', ['-c', 'core.fsmonitor=false', '-C', path, ...args], {
  timeout: 10_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
  env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
});

/**
 * Resolves when the checkout at `path` is at `sha` and has no change a snapshot would copy: a tracked file edited, staged
 * or deleted, or an untracked file it keeps; ignored files and those it never copies, such as .perpetual or .env, do not
 * count. Otherwise throws what to do, which a gate shows as why it needs release.
 */
export async function assertCheckoutAt(path: string, sha: string) {
  const head = await git(path, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(({ stdout }) => stdout.trim(), () => null);
  const short = (value: string) => value.slice(0, 7);
  if (head !== sha) throw new Error(`The checkout is at ${head ? short(head) : 'no commit'}, not ${short(sha)}. Scan the repository again, or check out ${short(sha)}, then run the gate.`);
  // Porcelain v1 with -z: "XY path" entries, a rename's or copy's original path as the entry after it.
  const status = await git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).then(({ stdout }) => stdout, () => null);
  const entries = status?.split('\0').filter(Boolean) ?? [], paths: string[] = [];
  for (let index = 0; index < entries.length; index++) { paths.push(entries[index].slice(3)); if (/^[RC]/.test(entries[index])) index++; }
  if (status === null || paths.some(snapshotKeeps)) throw new Error('The checkout has uncommitted changes, which a twin would copy. Commit or discard them, then run the gate.');
}
