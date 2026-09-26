const PLACEMENTS = ['start', 'end', 'top', 'bottom'];
const escape = text => String(text).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
const markup = chart => `<ul class="legend">${chart.series.map(item => `<li>${escape(item.name)}</li>`).join('')}</ul>`;

/**
 * A legend of the chart's series, as a plugin for acme-charts 3: chart.use(legend({ placement })). placement is start,
 * end (the default), top or bottom; anything else throws a RangeError.
 */
export function legend({ placement = 'end' } = {}) {
  if (!PLACEMENTS.includes(placement)) throw new RangeError(`Unknown legend placement ${placement}: use start, end, top or bottom.`);
  return { name: 'legend', slot: placement, render: markup };
}
