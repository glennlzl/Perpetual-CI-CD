# acme-charts

Small SVG line charts. Plugins add markup to a chart's slots: `top` and `bottom` of the figure, `start` and `end` of
its row, and `plot`, inside the SVG under the series.

```js
import { createChart } from 'acme-charts';

const chart = createChart({ title: 'Visits', series: [{ name: 'Web', values: [3, 5, 4] }] });
chart.use({ name: 'note', slot: 'bottom', render: () => '<p>Last three days</p>' });
chart.render();
```
