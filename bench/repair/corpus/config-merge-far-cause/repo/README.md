# orders

A small order service without a framework: a catalog, quotes and orders over an in-memory store, answered by a plain
router (`src/app.js`) that `src/server.js` serves over HTTP. Amounts are whole cents.

## Configuration

`loadConfig()` builds the configuration from three layers, each deep-merged over the ones before it, so a layer holds
only the settings it changes:

1. `config/default.json`;
2. `config/<NODE_ENV>.json`, when there is one (the test suite uses `test`);
3. `APP_*` environment variables. Double underscores separate levels and single underscores join words:
   `APP_SERVER__PORT=8080` sets `server.port`, and `APP_REGIONS__US__SHIPPING__FREE_FROM=7500` sets
   `regions.us.shipping.freeFrom`. `true`, `false` and numbers are parsed.

## Regions

Each region under `regions` has:

- `currency`: the currency code of its totals, USD when a region names none;
- `tax`: its `rate` of the item total, and `shipping`, whether shipping is taxed too. A region without a tax section is
  tax-free;
- `shipping`: a `flat` charge, waived once the discounted item total reaches `freeFrom`.

A discount code comes off the items first, rounded down to the cent; shipping follows the discounted item total; tax
comes last, rounded to the nearest cent.

## HTTP

- `GET /health`
- `GET /products` and `GET /products/:sku`
- `POST /quotes` with `{ region, lines: [{ sku, qty }], code? }`: the priced lines and totals, without placing an order
- `POST /orders` with the same body places the order; `GET /orders/:id` reads it back
