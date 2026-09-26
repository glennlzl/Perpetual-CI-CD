# Changelog

## 2.1.0
- The formatting helpers moved from `src/utils/` to `src/shared/format/`. Import them as `@shared/format/<name>.js`
  (the `@shared/*` path in tsconfig.json) rather than by relative path.

## 2.0.0
- `cartSummary(lines)` counts items and adds their prices.
