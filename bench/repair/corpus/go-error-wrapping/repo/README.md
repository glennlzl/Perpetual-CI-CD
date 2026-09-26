# stockroom

Stock levels by SKU over HTTP.

- `GET /items/{sku}` returns `{"sku": "…", "stock": n}`.
- `POST /items/{sku}/reserve` with `{"qty": n}` takes n units out of stock and returns what remains.

Errors are `{"error": "…"}` with 404 for an unknown SKU, 409 when too little is in stock, 400 for a quantity below 1 or a malformed body, and 500 for anything else.

Store and service errors wrap the store's sentinels, `store.ErrNotFound` and `store.ErrInsufficient`, with the SKU they concern, so callers test them with `errors.Is`.

```sh
go run ./cmd/stockroomd   # listens on :8080, or STOCKROOM_ADDR
```
