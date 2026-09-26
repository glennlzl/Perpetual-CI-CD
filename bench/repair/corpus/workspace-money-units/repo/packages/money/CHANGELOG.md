# Changelog

## 2.0.0
- **Breaking:** amounts are integer minor units. `format(minor, currency)` takes an integer number of minor units, so
  `format(1999, 'USD')` is `$19.99`, and throws a `TypeError` for anything else, such as `19.99`.
- `toMinor(amount, currency)` reads a decimal amount, such as a catalog price, into minor units with the currency's
  number of decimals. A 1.x call `format(price, currency)` becomes `format(toMinor(price, currency), currency)`; add
  amounts up in minor units.

## 1.3.0
- Added KWD.

## 1.0.0
- `format(amount, currency)` formats a decimal amount of major units: `format(19.99, 'USD')` is `$19.99`.
