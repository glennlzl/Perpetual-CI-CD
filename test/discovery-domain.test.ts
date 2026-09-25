import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { domainTerms, businessSourceContext } from '../src/business/discovery.ts';

test('domain terms come from the repository route vocabulary, not a built-in product list', () => {
  const shop = ['web/app/orders/page.tsx', 'web/app/orders/[id]/page.tsx', 'web/app/orders/new/page.tsx', 'web/app/products/page.tsx', 'web/app/products/[slug]/page.tsx', 'api/routes/orders.ts', 'api/routes/products.ts', 'web/components/product-card.tsx', 'web/app/settings/page.tsx', 'web/app/login/page.tsx'];
  assert.deepEqual(domainTerms(shop), ['order', 'product']);
  assert.deepEqual(domainTerms(['src/app/page.tsx', 'src/lib/utils.ts', 'src/components/ui/button.tsx']), []);
  assert.ok(!domainTerms(['a/billing/x.ts', 'b/billing/y.ts', 'c/billing/z.ts', 'a/settings/x.ts', 'b/settings/y.ts', 'c/settings/z.ts']).length, 'billing and settings keep their own areas');
});

test('browser discovery prioritizes an unfamiliar product\'s primary pages without product-specific rules', async t => {
  const root = await mkdtemp(join(tmpdir(), 'discovery-domain-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (name: string, content: string) => { await mkdir(join(root, dirname(name)), { recursive: true }); await writeFile(join(root, name), content); };
  await Promise.all(Array.from({ length: 230 }, (_, index) => write(`api/lib/helper-${String(index).padStart(3, '0')}.ts`, `export const unrelated = ${index};\n${'// filler\n'.repeat(800)}`)));
  for (const name of ['web/app/orders/page.tsx', 'web/app/orders/[id]/page.tsx', 'web/app/orders/new/page.tsx', 'api/routes/orders.ts']) await write(name, 'export async function createOrder() { return "Place order"; }\n');
  await write('web/app/checkout/page.tsx', 'export function Checkout() { return "Pay"; }\n');
  const context = await businessSourceContext(root, { scope: '' });
  const names = context.files.map(file => file.path);
  for (const name of ['web/app/orders/new/page.tsx', 'api/routes/orders.ts', 'web/app/checkout/page.tsx']) assert.ok(names.includes(name), name);
  assert.ok(names.indexOf('web/app/orders/new/page.tsx') < names.indexOf('api/lib/helper-000.ts'));
});
