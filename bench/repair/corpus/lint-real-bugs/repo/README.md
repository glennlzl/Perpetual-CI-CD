# checkout

Order totals for the web shop, in cents.

- `parsePrice(text)`: a price as a person typed it, such as `' 12.50 '`, in cents (`1250`). Text that is not a number
  throws `Invalid price`.
- `shippingFor(region)`: `domestic` 499, `eu` and `eea` 999, `intl` 1999. Any other region throws.
- `normalizeCoupon(code)`: the code trimmed and in upper case, so `' save10 '` is `SAVE10`.
- `couponPercent(code)`: the percentage a coupon takes off, or 0 for an unknown code.
- `orderTotal({ prices, coupon, region })`: the prices, less the coupon's percentage, plus shipping.

`npm run lint` runs Biome over `src`, and `npm test` runs the tests. See CONTRIBUTING.md.
