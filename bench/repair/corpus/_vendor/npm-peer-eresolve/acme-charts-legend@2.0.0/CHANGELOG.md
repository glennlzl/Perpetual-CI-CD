# Changelog

## 2.0.0
- For acme-charts 3 (peer ^3.0.0). acme-charts 2 stays on legend 1.x.
- Breaking: the default export `legend(chart, { position })` is replaced by the named export `legend({ placement })`,
  which returns a plugin to register: `chart.use(legend({ placement: 'end' }))`.
- Breaking: `position` left, right, top and bottom is now `placement` start, end, top and bottom. An unknown
  placement throws a `RangeError` instead of falling back to the default.
- The markup is unchanged.

## 1.9.0
- Requires acme-charts 2.5 or later 2.x releases (peer ^2.5.0).

## 1.2.0
- `position: 'top'` and `position: 'bottom'`.

## 1.0.0
- First release, for acme-charts 2: `legend(chart, { position })`, left or right.
