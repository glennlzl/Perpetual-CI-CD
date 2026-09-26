# Changelog

## 3.0.0
- Breaking: `chart.addPlugin(plugin)` is removed. Register plugins with `chart.use(plugin)`, which returns the chart
  too. Plugin objects are unchanged, so a plugin that returns one keeps working; a plugin that calls `addPlugin`
  itself needs a release for 3.x.
- The markup is unchanged.

## 2.4.0
- Series names are escaped in `data-name`.

## 2.0.0
- Breaking: plugins render into slots: `top`, `start`, `plot`, `end` and `bottom`.
