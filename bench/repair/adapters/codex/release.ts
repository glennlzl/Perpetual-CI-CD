// The pinned Codex release for a box's Linux machine. The product box accepts only official node, python, golang and
// buildpack-deps images, so there is no baked image: the first attempt of a run fetches the platform package from the
// npm registry, checks its bytes against the registry's sha512 integrity pinned here before anything is unpacked, and
// unpacks its package directory once into the git-ignored bench/repair/.cache/codex; prepare() copies it into each box.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { capture } from '../../../../src/repair/box.ts';
import { BENCH } from '../../box.ts';

export type Platform = 'linux-arm64' | 'linux-x64';
export interface Pin { name: string; version: string; license: string; platforms: Readonly<Record<Platform, { triple: string; integrity: string }>> }
/**
 * @openai/codex as verified on npm on 2026-09-25: the `latest` dist-tag, Apache-2.0, published 2026-09-25. Each Linux
 * build is the version `<version>-<platform>` of the same package, the optionalDependency its launcher resolves, with
 * the canonical package directory (bin/codex, bin/codex-code-mode-host, codex-resources, codex-path/rg) under
 * package/vendor/<triple>.
 */
export const RELEASE: Pin = {
  name: '@openai/codex', version: '0.157.0', license: 'Apache-2.0',
  platforms: {
    'linux-arm64': { triple: 'aarch64-unknown-linux-musl', integrity: 'sha512-67Y2HL4s+DEKtWr1oFz86iN+wLDRsdm6fuq8rhaxlt8QeIK79aO7Eg82Wfucou4QSisq/SSWYkwa9q7hWi8fLA==' },
    'linux-x64': { triple: 'x86_64-unknown-linux-musl', integrity: 'sha512-3TEPslRaNmlgJST5xMJJ9ZWXW1hr4RlVEpF0tO4NULNGj4b5naWlHa6PlSRiDpnMz322aJkz0uvyyKqc37rLJQ==' },
  },
};
export const tarballUrl = (pin: Pin, platform: Platform) => `https://registry.npmjs.org/${pin.name}/-/${pin.name.split('/').at(-1)}-${pin.version}-${platform}.tgz`;

/** The platform build for a box's `uname -m`, or null when Codex ships none for it. */
export function platformOf(machine: string): Platform | null {
  const name = machine.trim().toLowerCase();
  return name === 'aarch64' || name === 'arm64' ? 'linux-arm64' : name === 'x86_64' || name === 'amd64' ? 'linux-x64' : null;
}

const tar = (args: readonly string[], signal?: AbortSignal) => capture('tar', args, { env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, timeoutMs: 10 * 60_000, signal });
/** Whether the host has the tar that unpacks the release. */
export const tarAvailable = () => tar(['--version']).then(result => result.exitCode === 0, () => false);
const isFile = (path: string) => stat(path).then(info => info.isFile(), () => false);

export interface ReleaseOptions { cache?: string; fetcher?: typeof fetch; signal?: AbortSignal; pin?: Pin }
const releases = new Map<string, Promise<string>>();
/**
 * The host folder holding the unpacked package directory for platform: from the cache when it was verified before,
 * else downloaded, verified and unpacked, once per cache and platform however many attempts ask at the same time.
 */
export function codexRelease(platform: Platform, { cache = join(BENCH, '.cache', 'codex'), fetcher = fetch, signal, pin = RELEASE }: ReleaseOptions = {}) {
  const key = join(cache, pin.version, platform);
  let release = releases.get(key);
  if (!release) {
    release = unpack(platform, cache, fetcher, pin, signal);
    releases.set(key, release);
    release.catch(() => releases.delete(key));
  }
  return release;
}

async function unpack(platform: Platform, cache: string, fetcher: typeof fetch, pin: Pin, signal?: AbortSignal) {
  const { triple, integrity } = pin.platforms[platform], label = `${pin.name}@${pin.version}-${platform}`;
  const folder = join(cache, pin.version, platform), unpacked = join(folder, 'package', 'vendor', triple);
  const verified = async () => await readFile(join(folder, '.verified'), 'utf8').catch(() => '') === integrity && await isFile(join(unpacked, 'bin', 'codex'));
  if (await verified()) return unpacked;
  await mkdir(join(cache, pin.version), { recursive: true, mode: 0o700 });
  const work = await mkdtemp(join(cache, pin.version, `.${platform}-`));
  try {
    const archive = join(work, 'package.tgz'), hash = createHash('sha512');
    const response = await fetcher(tarballUrl(pin, platform), { signal });
    if (!response.ok || !response.body) throw new Error(`Could not download ${label} (HTTP ${response.status}).`);
    const body = response.body as AsyncIterable<Uint8Array>;
    await pipeline(async function* () { for await (const chunk of body) { hash.update(chunk); yield chunk; } }, createWriteStream(archive, { mode: 0o600 }), { signal });
    const actual = `sha512-${hash.digest('base64')}`;
    if (actual !== integrity) throw new Error(`${label} does not match its pinned integrity (got ${actual.slice(0, 23)}…); nothing was unpacked.`);
    const target = join(work, 'unpacked');
    await mkdir(target);
    const untar = await tar(['-xzf', archive, '-C', target, `package/vendor/${triple}`], signal);
    if (untar.exitCode !== 0) throw new Error(`Could not unpack ${label}: ${untar.stderr.trim().split('\n')[0] || `tar exited with ${untar.exitCode}`}.`);
    if (!await isFile(join(target, 'package', 'vendor', triple, 'bin', 'codex'))) throw new Error(`${label} has no bin/codex for ${triple}.`);
    await writeFile(join(target, '.verified'), integrity);
    await rm(folder, { recursive: true, force: true });
    // Another run may have put the same verified release in place meanwhile.
    await rename(target, folder).catch(async (error: unknown) => { if (!await verified()) throw error; });
    return unpacked;
  } finally { await rm(work, { recursive: true, force: true }); }
}
