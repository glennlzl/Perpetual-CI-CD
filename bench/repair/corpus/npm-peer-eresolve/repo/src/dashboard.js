import { createChart } from 'acme-charts';
import { grid } from 'acme-charts-grid';
import legend from 'acme-charts-legend';
import { PANELS } from './panels.js';

/**
 * A panel's chart markup: its series under its title, with gridLines grid lines and a legend on the side it names
 * (left, right, top or bottom; right by default), or no legend with 'none'.
 */
export function renderPanel({ title, series, legend: side = 'right', gridLines = 0 }) {
  const chart = createChart({ title, series });
  if (gridLines > 0) chart.addPlugin(grid({ lines: gridLines }));
  if (side !== 'none') legend(chart, { position: side });
  return chart.render();
}

/** The dashboard: every panel, in order. */
export const renderDashboard = (panels = PANELS) => `<main class="dashboard">${panels.map(panel => renderPanel(panel)).join('')}</main>`;
