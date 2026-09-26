const SLOTS = { left: 'start', right: 'end', top: 'top', bottom: 'bottom' };
const escape = text => String(text).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
const markup = chart => `<ul class="legend">${chart.series.map(item => `<li>${escape(item.name)}</li>`).join('')}</ul>`;

/**
 * Adds a legend of the chart's series on one side of it: left, right (the default), top or bottom; an unknown position
 * falls back to right. Returns the chart.
 */
export default function legend(chart, { position = 'right' } = {}) {
  return chart.addPlugin({ name: 'legend', slot: Object.hasOwn(SLOTS, position) ? SLOTS[position] : SLOTS.right, render: markup });
}
