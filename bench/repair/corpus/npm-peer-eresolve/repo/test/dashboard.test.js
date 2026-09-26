import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDashboard, renderPanel } from '../src/dashboard.js';
import { PANELS } from '../src/panels.js';

test('a panel draws its series with the legend on the right by default', () => {
  assert.equal(renderPanel({ title: 'Visits', series: [{ name: 'Web', values: [3, 5, 4] }] }),
    '<figure class="chart"><figcaption>Visits</figcaption><div class="chart-row"><svg class="plot"><polyline class="series" data-name="Web" points="0,3 1,5 2,4"/></svg><ul class="legend"><li>Web</li></ul></div></figure>');
});

test('grid lines sit in the plot under the series', () => {
  assert.equal(renderPanel({ title: 'Load', series: [{ name: 'CPU', values: [1, 2] }], legend: 'none', gridLines: 2 }),
    '<figure class="chart"><figcaption>Load</figcaption><div class="chart-row"><svg class="plot"><g class="grid"><line class="grid-line" data-step="1"/><line class="grid-line" data-step="2"/></g><polyline class="series" data-name="CPU" points="0,1 1,2"/></svg></div></figure>');
});

test('the dashboard renders every panel in order', () => {
  const html = renderDashboard();
  assert.ok(html.startsWith('<main class="dashboard"><figure class="chart"><figcaption>Visits</figcaption>'));
  assert.equal(html.match(/<figure /g).length, PANELS.length);
});
