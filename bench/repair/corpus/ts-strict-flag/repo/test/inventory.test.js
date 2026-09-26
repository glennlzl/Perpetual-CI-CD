import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../dist/csv.js';
import { quantityOf, toStock } from '../dist/inventory.js';
import { topSku } from '../dist/report.js';

const stock = toStock(parseCsv('apple,2\nbanana,5\n\napple,1\n'));

test('rows parse and repeated SKUs add up', () => {
  assert.deepEqual(parseCsv('apple,2\nbanana,5\n'), [{ sku: 'apple', quantity: 2 }, { sku: 'banana', quantity: 5 }]);
  assert.equal(quantityOf(stock, 'apple'), 3);
});

test('the top SKU has the most units', () => {
  assert.equal(topSku(stock), 'banana');
});
