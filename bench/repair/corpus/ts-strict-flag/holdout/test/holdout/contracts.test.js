import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../../dist/csv.js';
import { quantityOf, toStock } from '../../dist/inventory.js';
import { topSku } from '../../dist/report.js';

test('holdout: a malformed line throws with its line number', () => {
  assert.throws(() => parseCsv('apple,1\nwidget\n'), /^Error: Malformed line 2$/);
  assert.throws(() => parseCsv('apple,x'), /^Error: Malformed line 1$/);
});

test('holdout: an unknown SKU has 0 units', () => {
  assert.equal(quantityOf(toStock(parseCsv('apple,2')), 'pear'), 0);
});

test('holdout: an empty stock has no top SKU, and a tie goes to the first listed', () => {
  assert.equal(topSku({}), null);
  assert.equal(topSku(toStock(parseCsv('pear,4\nplum,4'))), 'pear');
});
