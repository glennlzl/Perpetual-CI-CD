# acme-charts-legend

A legend of a chart's series, for acme-charts 3.

```js
import { createChart } from 'acme-charts';
import { legend } from 'acme-charts-legend';

const chart = createChart({ title: 'Visits', series });
chart.use(legend({ placement: 'start' })); // start, end (the default), top or bottom
```
