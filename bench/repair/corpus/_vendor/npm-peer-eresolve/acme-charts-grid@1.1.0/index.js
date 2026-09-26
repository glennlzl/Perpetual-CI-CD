/**
 * A plugin drawing lines horizontal grid lines under a chart's series: chart.use(grid({ lines })) on acme-charts 3,
 * chart.addPlugin(grid({ lines })) on acme-charts 2.
 */
export function grid({ lines = 4 } = {}) {
  if (!Number.isInteger(lines) || lines < 1) throw new RangeError('lines must be a whole number from 1');
  const markup = Array.from({ length: lines }, (_, index) => `<line class="grid-line" data-step="${index + 1}"/>`).join('');
  return { name: 'grid', slot: 'plot', render: () => `<g class="grid">${markup}</g>` };
}
