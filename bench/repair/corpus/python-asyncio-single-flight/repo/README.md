# rates

Exchange rates for checkout, cached in memory.

`RateCache(loader, ttl_seconds=300, clock=time.monotonic)` sits in front of an async `loader(currency)` that returns how many US dollars one unit of the currency is worth.

- `await cache.get(currency)` returns the rate loaded less than `ttl_seconds` ago, or loads it.
- Concurrent calls for one currency share a single load.
- Different currencies load in parallel: a slow currency never holds up another.
- A failed load is not cached. Every call sharing it raises its exception, and the next `get()` loads again.

`await convert(cache, amount, source, target)` converts an amount between two currencies, rounded to cents.

```sh
python -m unittest discover -s tests -t . -v
```
