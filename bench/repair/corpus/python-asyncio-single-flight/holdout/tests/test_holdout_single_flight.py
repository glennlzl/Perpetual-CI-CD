import asyncio
import unittest

from rates.cache import RateCache
from rates.convert import convert
from tests.fakes import FakeClock, GatedLoader


class HoldoutSingleFlightTest(unittest.IsolatedAsyncioTestCase):
    async def test_holdout_a_failed_load_fails_every_waiter_once_and_is_not_cached(self):
        loader = GatedLoader()
        cache = RateCache(loader)
        gets = [asyncio.create_task(cache.get("CHF")) for _ in range(3)]
        await asyncio.wait_for(loader.started("CHF"), 1)
        error = LookupError("CHF feed down")
        loader.fail("CHF", error)
        results = await asyncio.wait_for(asyncio.gather(*gets, return_exceptions=True), 1)
        self.assertEqual(loader.calls, ["CHF"])
        for result in results:
            self.assertIs(result, error)
        again = asyncio.create_task(cache.get("CHF"))
        await asyncio.wait_for(loader.started("CHF"), 1)
        loader.release("CHF", 1.13)
        self.assertEqual(await asyncio.wait_for(again, 1), 1.13)
        self.assertEqual(loader.calls, ["CHF", "CHF"])

    async def test_holdout_other_currencies_load_while_one_waits(self):
        loader = GatedLoader()
        cache = RateCache(loader)
        sek = [asyncio.create_task(cache.get("SEK")) for _ in range(2)]
        nok = [asyncio.create_task(cache.get("NOK")) for _ in range(2)]
        await asyncio.wait_for(loader.started("SEK"), 1)
        await asyncio.wait_for(loader.started("NOK"), 1)
        loader.release("NOK", 0.094)
        self.assertEqual(await asyncio.wait_for(asyncio.gather(*nok), 1), [0.094, 0.094])
        self.assertFalse(any(task.done() for task in sek))
        loader.release("SEK", 0.096)
        self.assertEqual(await asyncio.wait_for(asyncio.gather(*sek), 1), [0.096, 0.096])
        self.assertEqual(sorted(loader.calls), ["NOK", "SEK"])

    async def test_holdout_an_expired_rate_reloads_once_for_concurrent_callers(self):
        clock = FakeClock()
        loader = GatedLoader()
        cache = RateCache(loader, ttl_seconds=30, clock=clock)
        first = asyncio.create_task(cache.get("JPY"))
        await asyncio.wait_for(loader.started("JPY"), 1)
        loader.release("JPY", 0.0067)
        self.assertEqual(await asyncio.wait_for(first, 1), 0.0067)
        clock.advance(31)
        gets = [asyncio.create_task(cache.get("JPY")) for _ in range(4)]
        await asyncio.wait_for(loader.started("JPY"), 1)
        loader.release("JPY", 0.0068)
        self.assertEqual(await asyncio.wait_for(asyncio.gather(*gets), 1), [0.0068] * 4)
        self.assertEqual(loader.calls, ["JPY", "JPY"])

    async def test_holdout_concurrent_conversions_load_each_currency_once(self):
        loader = GatedLoader()
        cache = RateCache(loader)
        conversions = asyncio.gather(
            convert(cache, 100, "EUR", "GBP"),
            convert(cache, 40, "GBP", "EUR"),
            convert(cache, 7, "EUR", "EUR"),
        )
        await asyncio.wait_for(loader.started("EUR"), 1)
        await asyncio.wait_for(loader.started("GBP"), 1)
        loader.release("EUR", 1.08)
        loader.release("GBP", 1.25)
        self.assertEqual(await asyncio.wait_for(conversions, 1), [86.4, 46.3, 7.0])
        self.assertEqual(sorted(loader.calls), ["EUR", "GBP"])


if __name__ == "__main__":
    unittest.main()
