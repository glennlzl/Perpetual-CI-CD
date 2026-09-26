// The bench corpus: generic failure classes in Node, TypeScript, Python and Go, each a tiny repository snapshot under
// corpus/<case>/repo with a CI workflow, a meta.json the agent never sees, a reference.patch proving the case solvable,
// holdout tests the judge adds only at judge time, and decoy patches (tempting hacks) the judge must fail. meta.json is
// read as unknown and validated. A case is materialized as the product's host copy is: one commit of the snapshot on
// the repair branch, with a fixed identity and date so its sha is the same on every run.
import { execFile } from 'node:child_process';
import { cp, lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const CORPUS = join(dirname(fileURLToPath(import.meta.url)), 'corpus');
export const FAILS = ['ci', 'guard', 'test-changed', 'rule', 'scripts'] as const;
export type DecoyFailure = typeof FAILS[number];
/** A JSON value a file must keep, such as tsconfig.json's compilerOptions.strict === true. */
export interface Guard { file: string; json: string[]; equals: unknown }
export interface Decoy { patch: string; fails: DecoyFailure; note: string }
export interface CaseMeta {
  repository: string; class: string; commitMessage: string; failingStep: string;
  expect: { logRegex: string; diagnosis: string }; guards: Guard[]; decoys: Decoy[]; notes: string;
  /** Authoring only: package.json fields the committed lockfile was generated from, when it is deliberately stale. */
  lockFrom?: Record<string, unknown>;
  /** Authoring only: vendored tarballs repo/vendor holds although package.json does not name them. */
  vendorAlso?: string[];
  /** Authoring only: false for a case that commits no lockfile, so none is generated. */
  lock?: false;
}
export interface Case { name: string; dir: string; repo: string; reference: string; holdout: string; meta: CaseMeta }

const exec = promisify(execFile);
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const NAME = /^[a-z][a-z\d-]{1,60}$/;
const REPOSITORY = /^[a-z\d][a-z\d-]{0,38}\/[a-z\d._-]{1,100}$/;
const PATH = /^(?![/.])[\w./-]{1,200}$/;
export const IDENTITY = { name: 'Acme Developer', email: 'dev@acme.example', date: '2026-01-01T00:00:00Z' };

function text(value: unknown, field: string, limit = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`meta.json: ${field} must be text of at most ${limit} characters.`);
  return value;
}
/** meta.json, validated. */
export function parseMeta(value: unknown): CaseMeta {
  if (!isRecord(value)) throw new Error('meta.json must be an object.');
  const repository = text(value.repository, 'repository', 200);
  if (!REPOSITORY.test(repository)) throw new Error('meta.json: repository must be owner/name.');
  const expect = isRecord(value.expect) ? value.expect : null;
  if (!expect) throw new Error('meta.json: expect must be an object.');
  const logRegex = text(expect.logRegex, 'expect.logRegex', 500);
  new RegExp(logRegex);
  const guards = (Array.isArray(value.guards) ? value.guards : []).map((guard, index): Guard => {
    if (!isRecord(guard) || !Array.isArray(guard.json) || !guard.json.length || !guard.json.every(part => typeof part === 'string' && part) || !('equals' in guard)) throw new Error(`meta.json: guards[${index}] needs file, json and equals.`);
    const file = text(guard.file, `guards[${index}].file`, 200);
    if (!PATH.test(file)) throw new Error(`meta.json: guards[${index}].file must be a repository path.`);
    return { file, json: guard.json as string[], equals: guard.equals };
  });
  const decoys = (Array.isArray(value.decoys) ? value.decoys : []).map((decoy, index): Decoy => {
    if (!isRecord(decoy) || !FAILS.includes(decoy.fails as DecoyFailure)) throw new Error(`meta.json: decoys[${index}].fails must be one of ${FAILS.join(', ')}.`);
    const patch = text(decoy.patch, `decoys[${index}].patch`, 200);
    if (!/^decoys\/[\w-]+\.patch$/.test(patch)) throw new Error(`meta.json: decoys[${index}].patch must be decoys/<name>.patch.`);
    return { patch, fails: decoy.fails as DecoyFailure, note: typeof decoy.note === 'string' ? decoy.note.slice(0, 500) : '' };
  });
  if (value.lockFrom !== undefined && !isRecord(value.lockFrom)) throw new Error('meta.json: lockFrom must be an object.');
  const vendorAlso = value.vendorAlso;
  if (vendorAlso !== undefined && !(Array.isArray(vendorAlso) && vendorAlso.every(file => typeof file === 'string' && /^[\w.-]+\.tgz$/.test(file)))) throw new Error('meta.json: vendorAlso must list tarball names.');
  if (value.lock !== undefined && (value.lock !== false || value.lockFrom !== undefined)) throw new Error('meta.json: lock may only be false, without lockFrom.');
  return {
    repository, class: text(value.class, 'class', 100), commitMessage: text(value.commitMessage, 'commitMessage', 500), failingStep: text(value.failingStep, 'failingStep', 200),
    expect: { logRegex, diagnosis: text(expect.diagnosis, 'expect.diagnosis', 100) }, guards, decoys, notes: text(value.notes, 'notes', 4000),
    ...(value.lockFrom ? { lockFrom: value.lockFrom as Record<string, unknown> } : {}),
    ...(vendorAlso ? { vendorAlso: vendorAlso as string[] } : {}), ...(value.lock === false ? { lock: false as const } : {}),
  };
}

/** Every case, or the named ones, in name order. */
export async function loadCases(names: readonly string[] | 'all' = 'all', root = CORPUS): Promise<Case[]> {
  const all = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() && NAME.test(entry.name)).map(entry => entry.name).sort();
  const chosen = names === 'all' ? all : [...names];
  const unknown = chosen.filter(name => !all.includes(name));
  if (unknown.length) throw new Error(`Unknown cases: ${unknown.join(', ')}. Cases: ${all.join(', ')}.`);
  return Promise.all(chosen.map(async name => {
    const dir = join(root, name);
    const meta = parseMeta(JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as unknown);
    return { name, dir, repo: join(dir, 'repo'), reference: join(dir, 'reference.patch'), holdout: join(dir, 'holdout'), meta };
  }));
}

const git = (cwd: string, args: string[], env: Record<string, string> = {}) => exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
  cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', LANG: 'C', ...env },
}).then(result => result.stdout.trim());

/**
 * The case's snapshot as one commit in directory (empty or missing), on perpetual/repair/<short sha> as the product's
 * host copy is; returns the commit. Its author, committer and date are fixed, so the sha depends only on the files.
 */
export async function materialize(c: Pick<Case, 'repo' | 'meta'>, directory: string): Promise<string> {
  await cp(c.repo, directory, { recursive: true, verbatimSymlinks: true });
  const identity = { GIT_AUTHOR_NAME: IDENTITY.name, GIT_AUTHOR_EMAIL: IDENTITY.email, GIT_AUTHOR_DATE: IDENTITY.date, GIT_COMMITTER_NAME: IDENTITY.name, GIT_COMMITTER_EMAIL: IDENTITY.email, GIT_COMMITTER_DATE: IDENTITY.date };
  await git(directory, ['init', '--quiet']);
  await git(directory, ['config', 'core.ignorecase', 'false']);
  await git(directory, ['add', '-A']);
  await git(directory, ['commit', '--quiet', '--no-verify', '-m', c.meta.commitMessage], identity);
  const sha = await git(directory, ['rev-parse', 'HEAD']);
  await git(directory, ['branch', '-m', `perpetual/repair/${sha.slice(0, 7)}`]);
  return sha;
}

/** A materialized snapshot's commit. */
export const head = (directory: string) => git(directory, ['rev-parse', 'HEAD']);

/** Whether a patch applies to the materialized snapshot, checked with git on the host. */
export async function applies(directory: string, patch: string) {
  return git(directory, ['apply', '--check', '--whitespace=nowarn', patch]).then(() => true, () => false);
}

/** Files under a folder, relative to it, for the corpus lint. */
export async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(entries.map(async entry => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return listFiles(root, path);
    return (await lstat(join(root, path))).isFile() ? [path] : [];
  }));
  return files.flat().sort();
}
