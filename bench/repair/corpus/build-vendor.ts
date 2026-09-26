// Corpus authoring: packs the vendored packages under corpus/_vendor, each a <name>@<version> folder, or
// <case>/<name>@<version> for packages only that case uses, with npm pack in a bench box; writes each tarball a case's
// package.json names (file:vendor/<name>-<version>.tgz), and each its meta.json's vendorAlso lists, into its repo/vendor;
// and generates each case's package-lock.json there with the box image's npm (npm install --package-lock-only), from its
// package.json and its other package.json files, such as its workspaces', except for a case whose meta.json has
// lock: false, which commits no lockfile. A case whose meta.json has lockFrom gets its lock generated from package.json
// with those fields applied, so it is stale on purpose; with --fixed-locks <dir>, the lock of its real package.json is
// written to <dir>/<case>/package-lock.json too, for its reference patch. Registry devDependencies, such as typescript
// or @biomejs/biome, resolve from the public registry through the box's egress proxy. A case without a package.json
// (the Python and Go cases) has nothing to vendor or lock and is skipped.
//   node corpus/build-vendor.ts [--fixed-locks <dir>] [case…]
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createBenchBox, useBenchDocker, type BenchBox } from '../box.ts';
import { CORPUS, listFiles, loadCases } from '../corpus.ts';

const IMAGE = 'node:22-bookworm';
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
async function sh(box: BenchBox, script: string, stdin?: string) {
  const result = await box.exec(['bash', '-eo', 'pipefail', '-c', script], { timeoutMs: 10 * 60_000, limit: 32 * 1024 * 1024, ...(stdin === undefined ? {} : { stdin }) });
  if (result.exitCode !== 0) throw new Error(`${script.split('\n')[0]} failed:\n${(result.stdout + result.stderr).slice(-4000)}`);
  return result.stdout;
}
/** The vendored tarballs a package.json names. */
const tarballs = (manifest: Record<string, unknown>) => ['dependencies', 'devDependencies'].flatMap(field => Object.values(isRecord(manifest[field]) ? manifest[field] : {}))
  .flatMap(spec => typeof spec === 'string' && /^file:vendor\/[\w.-]+\.tgz$/.test(spec) ? [spec.slice('file:vendor/'.length)] : []);
/** The package folders under _vendor, relative to it: <name>@<version>, and <case>/<name>@<version>. */
async function packageFolders(root: string) {
  const folders: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.includes('@')) { folders.push(entry.name); continue; }
    for (const inner of await readdir(join(root, entry.name), { withFileTypes: true })) if (inner.isDirectory() && inner.name.includes('@')) folders.push(`${entry.name}/${inner.name}`);
  }
  return folders.sort();
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'fixed-locks': { type: 'string' } } });
  await useBenchDocker();
  const cases = await loadCases(positionals.length ? positionals : 'all');
  const stage = await mkdtemp(join(tmpdir(), 'bench-vendor-')), root = await mkdtemp(join(tmpdir(), 'bench-vendor-boxes-'));
  await cp(join(CORPUS, '_vendor'), join(stage, '_vendor'), { recursive: true });
  const box = await createBenchBox({ image: IMAGE, source: stage, root });
  try {
    const packed = new Map<string, Buffer>();
    for (const folder of await packageFolders(join(CORPUS, '_vendor'))) {
      const file = (await sh(box, `mkdir -p /packed && cd ${quote(`/workspace/_vendor/${folder}`)} && npm pack --pack-destination /packed --silent`)).trim().split('\n').at(-1) ?? '';
      if (packed.has(file)) throw new Error(`Two vendored folders pack to ${file}.`);
      packed.set(file, Buffer.from((await sh(box, `base64 -w0 ${quote(`/packed/${file}`)}`)).trim(), 'base64'));
      console.log(`packed ${file}`);
    }
    for (const c of cases) {
      const text = await readFile(join(c.repo, 'package.json'), 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
      if (text === null) { console.log(`skipped ${c.name} (no package.json)`); continue; }
      const manifest = JSON.parse(text) as Record<string, unknown>;
      const locked = c.meta.lockFrom ? { ...manifest, ...c.meta.lockFrom } : manifest;
      const committed = [...new Set([...tarballs(manifest), ...(c.meta.vendorAlso ?? [])])];
      const needed = [...new Set([...committed, ...tarballs(locked)])];
      const missing = needed.filter(file => !packed.has(file));
      if (missing.length) throw new Error(`${c.name} names tarballs that are not vendored: ${missing.join(', ')}.`);
      await rm(join(c.repo, 'vendor'), { recursive: true, force: true });
      for (const file of committed) { await mkdir(join(c.repo, 'vendor'), { recursive: true }); await writeFile(join(c.repo, 'vendor', file), packed.get(file)!); }
      if (c.meta.lock === false) {
        await rm(join(c.repo, 'package-lock.json'), { force: true });
        console.log(`vendored ${c.name} (no lockfile)`);
        continue;
      }
      const work = `/cases/${c.name}`;
      await sh(box, `rm -rf ${quote(work)} && mkdir -p ${quote(`${work}/vendor`)}`);
      for (const file of needed) await sh(box, `base64 -d > ${quote(`${work}/vendor/${file}`)}`, packed.get(file)!.toString('base64'));
      // The case's other package.json files, such as its workspaces', which npm reads to lock their links.
      for (const path of (await listFiles(c.repo)).filter(file => file.endsWith('/package.json') && !/(^|\/)node_modules\//.test(file))) {
        await sh(box, `mkdir -p ${quote(`${work}/${path.slice(0, path.lastIndexOf('/'))}`)} && cat > ${quote(`${work}/${path}`)}`, await readFile(join(c.repo, path), 'utf8'));
      }
      const lock = async (json: Record<string, unknown>) => {
        await sh(box, `rm -f ${quote(`${work}/package-lock.json`)} && cat > ${quote(`${work}/package.json`)}`, `${JSON.stringify(json, null, 2)}\n`);
        return sh(box, `cd ${quote(work)} && npm install --package-lock-only --ignore-scripts --no-audit --no-fund --silent >&2 && cat package-lock.json`);
      };
      await writeFile(join(c.repo, 'package-lock.json'), await lock(locked));
      if (c.meta.lockFrom && values['fixed-locks']) {
        await mkdir(join(values['fixed-locks'], c.name), { recursive: true });
        await writeFile(join(values['fixed-locks'], c.name, 'package-lock.json'), await lock(manifest));
      }
      console.log(`locked ${c.name}${c.meta.lockFrom ? ' (stale on purpose)' : ''}`);
    }
  } finally {
    await box.remove();
    await rm(stage, { recursive: true, force: true }); await rm(root, { recursive: true, force: true });
  }
}

await main();
