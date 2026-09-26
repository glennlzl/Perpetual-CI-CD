import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = join(import.meta.dirname, '..', '..', 'dist');
const load = file => import(pathToFileURL(join(dist, file)).href);
const teapot = { sku: 't1', name: 'Glass Teapot', cents: 2250 };
const filters = { sku: 'f1', name: 'Paper Filters', cents: 450 };
const grinder = { sku: 'g1', name: 'Burr Grinder', cents: 3900 };

test('holdout: every compiled module loads', async () => {
  for (const file of ['index.js', 'cart/summary.js', 'catalog/product.js', 'catalog/listing.js']) await load(file);
});

test('holdout: prices and slugs of new values', async () => {
  const { formatPrice, slugify } = await load('index.js');
  assert.equal(formatPrice(123456), '$1234.56');
  assert.equal(formatPrice(-250, 'EUR'), '-€2.50');
  assert.equal(formatPrice(0), '$0.00');
  assert.equal(slugify('Café Crème 2L'), 'cafe-creme-2l');
  assert.equal(slugify('--Already--Slugged--'), 'already-slugged');
});

test('holdout: cards, listings and carts of new products', async () => {
  const { productCard } = await load('catalog/product.js');
  const { listing } = await load('catalog/listing.js');
  const { cartSummary } = await load('cart/summary.js');
  assert.deepEqual(productCard(grinder), { path: '/products/burr-grinder', title: 'Burr Grinder', price: '$39.00' });
  assert.deepEqual(listing('Tea & Coffee', [teapot, grinder, filters]), { path: '/c/tea-coffee', lines: ['Paper Filters $4.50', 'Glass Teapot $22.50', 'Burr Grinder $39.00'] });
  assert.equal(cartSummary([{ product: teapot, quantity: 1 }]), '1 item, $22.50');
  assert.equal(cartSummary([{ product: filters, quantity: 3 }, { product: grinder, quantity: 1 }]), '4 items, $52.50');
  assert.equal(cartSummary([]), '0 items, $0.00');
});

test('holdout: the compiled package runs from another directory with no loader', () => {
  const script = `const { cartSummary } = await import(${JSON.stringify(pathToFileURL(join(dist, 'index.js')).href)});\nconsole.log(cartSummary([{ product: { sku: 'b', name: 'Burr Grinder', cents: 3900 }, quantity: 2 }]));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: tmpdir(), encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '2 items, $78.00');
});
