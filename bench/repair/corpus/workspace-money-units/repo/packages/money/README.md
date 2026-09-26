# @acme/money

Formats and parses amounts of money. Since 2.0 every amount is an integer number of minor units: cents for USD and
EUR, yen for JPY (no decimals) and fils for KWD (three decimals). The CHANGELOG says how to migrate from 1.x.

- `format(minor, currency)`: the amount with the currency's symbol, thousands separators and decimals.
  `format(123450, 'EUR')` is `€1,234.50` and `format(3750, 'JPY')` is `¥3,750`. Anything but an integer throws a
  `TypeError`.
- `toMinor(amount, currency)`: a decimal amount, such as a catalog price, in minor units. `toMinor('19.99', 'USD')` is
  `1999` and `toMinor('0.625', 'KWD')` is `625`.
- `currency(code)`: `{ symbol, exponent }`, where the exponent is the number of decimals.

Currencies: USD (`$`), EUR (`€`), JPY (`¥`) and KWD (`KD `).
