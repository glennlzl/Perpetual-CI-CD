# storefront

Acme's storefront, as npm workspaces:

- `packages/money` (`@acme/money`): formats and parses amounts of money.
- `packages/cart` (`@acme/cart`): the cart and its checkout total.
- `packages/receipts` (`@acme/receipts`): the receipt text of an order.

`npm test` runs the tests of every workspace; `npm test -w @acme/cart` runs one.
