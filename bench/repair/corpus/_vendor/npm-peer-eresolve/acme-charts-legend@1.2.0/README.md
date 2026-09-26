# acme-charts-legend

A legend of a chart's series, for acme-charts 2.

```js
import { createChart } from 'acme-charts';
import legend from 'acme-charts-legend';

const chart = createChart({ title: 'Visits', series });
legend(chart, { position: 'left' }); // left, right (the default), top or bottom
```
