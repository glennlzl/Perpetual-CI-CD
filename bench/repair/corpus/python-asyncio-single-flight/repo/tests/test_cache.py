import asyncio
import unittest

from rates.cache import RateCache
from tests.fakes import FakeClock, GatedLoader, TableLoader


class RateCacheTest(unittest.IsolatedAsyncioTestCase):
    async def test_cached_rate_is_reused_until_it_expires(self):
        clock = FakeClock()
        loader = TableLoader({"EUR": 1.08})
        cache = RateCache(loader, ttl_seconds=60, clock=clock)
        self.assertEqual(await cache.get("EUR"), 1.08)
        clock.advance(59)
        self.assertEqual(await cache.get("EUR"), 1.08)
        self.assertEqual(loader.calls, ["EUR"])
        loader.table["EUR"] = 1.09
        clock.advance(2)
        self.assertEqual(await cache.get("EUR"), 1.09)
        self.assertEqual(loader.calls, ["EUR", "EUR"])

    async def test_failed_load_is_not_cached(self):
        loader = TableLoader({"EUR": LookupError("EUR feed down")})
        cache = RateCache(loader)
        with self.assertRaises(LookupError):
            await cache.get("EUR")
        loader.table["EUR"] = 1.08
        self.assertEqual(await cache.get("EUR"), 1.08)
        self.assertEqual(loader.calls, ["EUR", "EUR"])

    async def test_concurrent_gets_share_one_load(self):
        loader = GatedLoader()
        cache = RateCache(loader)
        gets = [asyncio.create_task(cache.get("EUR")) for _ in range(3)]
        await asyncio.wait_for(loader.started("EUR"), 1)
        loader.release("EUR", 1.08)
        self.assertEqual(await asyncio.wait_for(asyncio.gather(*gets), 1), [1.08, 1.08, 1.08])
        self.assertEqual(loader.calls, ["EUR"])

    async def test_different_currencies_load_in_parallel(self):
        loader = GatedLoader()
        cache = RateCache(loader)
        eur = asyncio.create_task(cache.get("EUR"))
        gbp = asyncio.create_task(cache.get("GBP"))
        # GBP's load starts while EUR's still waits at its gate.
        await asyncio.wait_for(loader.started("EUR"), 1)
        await asyncio.wait_for(loader.started("GBP"), 1)
        loader.release("GBP", 1.27)
        loader.release("EUR", 1.08)
        self.assertEqual(await asyncio.wait_for(asyncio.gather(eur, gbp), 1), [1.08, 1.27])
        self.assertEqual(sorted(loader.calls), ["EUR", "GBP"])


if __name__ == "__main__":
    unittest.main()
