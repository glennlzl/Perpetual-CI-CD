const SLOTS = ['top', 'start', 'plot', 'end', 'bottom'];
const escape = text => String(text).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);

/**
 * A line chart of series ({ name, values }) under a title. Plugins ({ name, slot, render(chart) }) add markup to a
 * slot: top or bottom of the figure, start or end of its row, or plot, inside the SVG under the series.
 */
export function createChart({ title = '', series = [] } = {}) {
  const plugins = [];
  const chart = {
    title,
    series,
    /** Registers a plugin; returns the chart. */
    use(plugin) {
      if (!plugin || typeof plugin.render !== 'function' || !SLOTS.includes(plugin.slot)) throw new TypeError(`A plugin needs a render function and a slot: ${SLOTS.join(', ')}.`);
      plugins.push(plugin);
      return chart;
    },
    /** The chart's markup. */
    render() {
      const slot = name => plugins.filter(plugin => plugin.slot === name).map(plugin => plugin.render(chart)).join('');
      const lines = series.map(item => `<polyline class="series" data-name="${escape(item.name)}" points="${item.values.map((value, index) => `${index},${value}`).join(' ')}"/>`).join('');
      return `<figure class="chart"><figcaption>${escape(title)}</figcaption>${slot('top')}<div class="chart-row">${slot('start')}<svg class="plot">${slot('plot')}${lines}</svg>${slot('end')}</div>${slot('bottom')}</figure>`;
    },
  };
  return chart;
}
