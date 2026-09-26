# catalog

Storefront catalog helpers. `npm run build` compiles `src` to `dist`, which the package runs from.

- `productCard(product)`: `{ path, title, price }` for a product `{ sku, name, cents }`.
- `listing(category, products)`: a category page's path and one line per product, cheapest first.
- `cartSummary(lines)`: `'3 items, $52.97'` for lines `{ product, quantity }`.
- `formatPrice(cents, currency)` and `slugify(text)`.
