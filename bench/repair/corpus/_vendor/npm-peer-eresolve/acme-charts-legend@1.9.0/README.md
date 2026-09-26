# acme-charts-legend

A legend of a chart's series, for acme-charts 2.5 and later 2.x releases.

```js
import { createChart } from 'acme-charts';
import legend from 'acme-charts-legend';

const chart = createChart({ title: 'Visits', series });
legend(chart, { position: 'left' }); // left, right (the default), top or bottom
```
