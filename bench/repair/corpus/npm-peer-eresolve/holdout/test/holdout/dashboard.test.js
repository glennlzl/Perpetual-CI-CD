import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPanel } from '../../src/dashboard.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const installed = name => JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version;

// The markup acme-charts 2.4 with acme-charts-legend 1.2 rendered before the upgrade.
const series = [{ name: 'R&D', values: [7, 2] }, { name: 'Ops', values: [4, 9] }];
const plot = '<svg class="plot"><polyline class="series" data-name="R&amp;D" points="0,7 1,2"/><polyline class="series" data-name="Ops" points="0,4 1,9"/></svg>';
const list = '<ul class="legend"><li>R&amp;D</li><li>Ops</li></ul>';
const figure = ({ top = '', start = '', end = '', bottom = '' }) => `<figure class="chart"><figcaption>Spend &amp; headcount</figcaption>${top}<div class="chart-row">${start}${plot}${end}</div>${bottom}</figure>`;
const panel = side => renderPanel({ title: 'Spend & headcount', series, legend: side });

test('holdout: each legend side renders as it did before the upgrade', () => {
  assert.equal(panel('left'), figure({ start: list }));
  assert.equal(panel('right'), figure({ end: list }));
  assert.equal(panel('top'), figure({ top: list }));
  assert.equal(panel('bottom'), figure({ bottom: list }));
});

test('holdout: a panel without a legend, and one with grid lines', () => {
  assert.equal(panel('none'), figure({}));
  assert.equal(renderPanel({ title: 'Queue', series: [{ name: 'Jobs', values: [5] }], legend: 'top', gridLines: 3 }),
    '<figure class="chart"><figcaption>Queue</figcaption><ul class="legend"><li>Jobs</li></ul><div class="chart-row"><svg class="plot"><g class="grid"><line class="grid-line" data-step="1"/><line class="grid-line" data-step="2"/><line class="grid-line" data-step="3"/></g><polyline class="series" data-name="Jobs" points="0,5"/></svg></div></figure>');
});

test('holdout: acme-charts 3 is installed with a legend release made for it', () => {
  assert.equal(installed('acme-charts'), '3.0.0');
  assert.match(installed('acme-charts-legend'), /^2\./);
  assert.equal(installed('acme-charts-grid'), '1.1.0');
});

test('holdout: the installed tree satisfies every peer dependency', () => {
  const listed = spawnSync('npm', ['ls', '--all'], { cwd: root, encoding: 'utf8' });
  assert.equal(listed.status, 0, `${listed.stdout}${listed.stderr}`);
});
