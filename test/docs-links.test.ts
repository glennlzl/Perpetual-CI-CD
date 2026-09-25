import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Current documentation names files the repository has. Dated plans and specs under docs/superpowers record history
// and keep the paths of their day; a current document marks such a path as history in words, not as a live link.
const root = fileURLToPath(new URL('..', import.meta.url));
const exists = (path: string) => access(path).then(() => true, () => false);

async function documents(directory: string): Promise<string[]> {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() && entry.name !== 'superpowers' ? documents(join(directory, entry.name)) : Promise.resolve(entry.name.endsWith('.md') ? [join(directory, entry.name)] : [])));
  return nested.flat();
}

test('current documents link only to files the repository has, and name no retired file as present', async () => {
  const missing: string[] = [];
  for (const file of ['README.md', 'CONTEXT.md', ...await documents('docs')]) {
    const text = await readFile(join(root, file), 'utf8');
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(?:[a-z]+:|#)/i.test(target)) continue;
      const path = join(root, dirname(file), decodeURIComponent(target.split('#')[0]));
      if (!await exists(path)) missing.push(`${file} -> ${relative(root, path)}`);
    }
  }
  assert.deepEqual(missing, []);
  // The retired standalone icon helper is not described as kept.
  assert.doesNotMatch(await readFile(join(root, 'docs/ASSETS.md'), 'utf8'), /public\/icons\.js|\/icons\.js/);
});
