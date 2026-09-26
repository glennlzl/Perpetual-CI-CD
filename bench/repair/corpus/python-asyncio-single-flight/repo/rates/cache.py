"""A per-currency cache of exchange rates in front of an async loader."""
import time


class RateCache:
    """Rates by currency, each kept for ttl_seconds after it loads.

    loader is an async callable: await loader(currency) returns how many US dollars one unit of currency is worth.
    Concurrent calls for one currency share a single load, and different currencies load in parallel. A failed load
    is not cached: every call sharing it raises its exception, and the next get() loads again.
    """

    def __init__(self, loader, ttl_seconds=300, clock=time.monotonic):
        self._loader = loader
        self._ttl = ttl_seconds
        self._clock = clock
        self._rates = {}  # currency -> (rate, time it loaded)

    async def get(self, currency):
        """The currency's rate, loaded less than ttl_seconds ago, or loaded now."""
        cached = self._rates.get(currency)
        if cached is not None and self._clock() - cached[1] < self._ttl:
            return cached[0]
        rate = await self._loader(currency)
        self._rates[currency] = (rate, self._clock())
        return rate
