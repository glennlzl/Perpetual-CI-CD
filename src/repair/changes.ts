// Change rules a repair's diff meets before every push, without a model. A rejection fails the attempt and its reason
// goes back to the agent; a hold is allowed but keeps the pull request for a person (phase 3 turns auto-merge off). CI
// and deploy configuration are rejected, not held: a pushed branch runs its own workflows with the repository's secrets,
// and deploy previews build from its configuration, before any person looks.
import { posix } from 'node:path';
import { hasCredential } from '../redaction.ts';

export interface ChangeCheck { paths: string[]; added: number; removed: number; rejected: string[]; holds: string[] }

/** Changed lines beyond which a change is held for a person. */
export const SIZE_LIMIT = 400;
export const REJECTED = {
  credential: 'The change adds text that looks like a credential. Remove it; a repair never adds secrets.',
  path: 'The change touches .git or a path outside the repository. Change files inside the repository only.',
  submodule: 'The change adds or moves a submodule. Change files inside the repository only.',
  delivery: 'The change touches CI or deployment configuration. A repair changes the code that fails, never how it is built or deployed.',
};
export const HELD = {
  tests: 'The change touches tests.',
  size: `The change is larger than ${SIZE_LIMIT} lines.`,
};
const TEST_FOLDERS = new Set(['test', 'tests', '__tests__', 'spec', '__snapshots__']);
const TEST_FILE = /\.(?:test|spec)\.[^/]+$|_test\.(?:go|py)$|^test_[^/]*\.py$|_spec\.rb$/;
// Source code, where an unquoted value is an expression rather than a literal.
const CODE = /\.(?:[cm]?[jt]sx?|py|rb|go|java|kts?|scala|groovy|gradle|rs|php|cs|fs|swift|dart|exs?|erl|clj|lua|pl|r|jl|vue|svelte|c|h|cc|cpp|hpp|m|mm)$/i;

/** A path git names in a diff header: C-quoted when it has special characters, and relative to the repository. */
function unquote(value: string) {
  if (!value.startsWith('"')) return value.replace(/\t$/, '');
  const escapes: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"' };
  const bytes: number[] = [];
  for (let index = 1; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"') break;
    if (char !== '\\') { bytes.push(...Buffer.from(char)); continue; }
    const next = value[index + 1];
    if (/[0-7]/.test(next)) { bytes.push(parseInt(value.slice(index + 1, index + 4), 8)); index += 3; }
    else { bytes.push(...Buffer.from(escapes[next] ?? next)); index += 1; }
  }
  return Buffer.from(bytes).toString('utf8');
}
const prefixed = (value: string, prefix: string) => { const path = unquote(value); return path.startsWith(prefix) ? path.slice(prefix.length) : null; };

/** The two paths of a `diff --git a/X b/Y` header; without renames both name the same file. */
function headerPaths(rest: string): string[] {
  if (rest.startsWith('"')) {
    const split = /^("(?:[^"\\]|\\.)*")\s+(.+)$/.exec(rest);
    return split ? [prefixed(split[1], 'a/'), prefixed(split[2], 'b/')].filter((path): path is string => path !== null) : [rest];
  }
  const length = (rest.length - 5) / 2, path = rest.slice(2, 2 + length);
  return Number.isInteger(length) && rest === `a/${path} b/${path}` ? [path] : [rest];
}

/** A path inside the repository, never through .git and never out of it. */
export function insideRepository(path: string) {
  if (!path || path.includes('\0') || path.includes('\\') || posix.isAbsolute(path)) return false;
  const parts = path.split('/');
  return parts.every(part => part && part !== '.' && part !== '..' && !/^\.git[. ]*$/i.test(part));
}

/** Rejections and holds for a change's paths; deployFiles are the deploy configuration files the scan found. */
export function pathRules(paths: readonly string[], deployFiles: readonly string[] = []) {
  const rejected: string[] = [], holds: string[] = [], deploy = new Set(deployFiles);
  if (paths.some(path => !insideRepository(path))) rejected.push(REJECTED.path);
  if (paths.some(path => path.startsWith('.github/') || deploy.has(path))) rejected.push(REJECTED.delivery);
  if (paths.some(path => path.split('/').slice(0, -1).some(part => TEST_FOLDERS.has(part)) || TEST_FILE.test(posix.basename(path)))) holds.push(HELD.tests);
  return { rejected, holds };
}

/**
 * The rules for a `git diff` with prefixes a/ and b/: its paths, changed lines, rejections and holds. A binary patch's
 * content is not read here; the host copy checks git's --text diff of what it staged, binary files included.
 */
export function checkChanges(diff: string, { deployFiles = [] }: { deployFiles?: readonly string[] } = {}): ChangeCheck {
  const paths = new Set<string>(), rejected = new Set<string>();
  let added = 0, removed = 0, hunk = false, binary = false, code = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const named = headerPaths(line.slice(11));
      hunk = false; binary = false; code = CODE.test(named.at(-1) ?? '');
      named.forEach(path => paths.add(path));
      continue;
    }
    if (binary) continue;
    if (hunk) {
      if (line.startsWith('+')) { added += 1; if (hasCredential(line.slice(1), { code })) rejected.add(REJECTED.credential); continue; }
      if (line.startsWith('-')) { removed += 1; continue; }
      if (line.startsWith(' ') || line.startsWith('\\') || line === '') continue;
      hunk = false;
    }
    if (line.startsWith('@@')) { hunk = true; continue; }
    if (line === 'GIT binary patch') { binary = true; continue; }
    const header = /^(?:---|\+\+\+) (.+)$/.exec(line) ?? /^(?:rename|copy) (?:from|to) (.+)$/.exec(line);
    if (header) {
      const path = line.startsWith('---') ? prefixed(header[1], 'a/') : line.startsWith('+++') ? prefixed(header[1], 'b/') : unquote(header[1]);
      if (header[1] !== '/dev/null') paths.add(path ?? header[1]);
      continue;
    }
    if (/^(?:new file mode|deleted file mode|old mode|new mode) 160000$|^index [\da-f]+\.\.[\da-f]+ 160000$/.test(line)) rejected.add(REJECTED.submodule);
  }
  const listed = [...paths], rules = pathRules(listed, deployFiles);
  rules.rejected.forEach(reason => rejected.add(reason));
  const holds = [...rules.holds, ...(added + removed > SIZE_LIMIT ? [HELD.size] : [])];
  return { paths: listed, added, removed, rejected: [...rejected], holds };
}
