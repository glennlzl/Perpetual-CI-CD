import unittest

from rates.cache import RateCache
from rates.convert import convert
from tests.fakes import TableLoader


class ConvertTest(unittest.IsolatedAsyncioTestCase):
    async def test_converts_through_dollar_rates(self):
        loader = TableLoader({"EUR": 1.08, "GBP": 1.25})
        cache = RateCache(loader)
        self.assertEqual(await convert(cache, 100, "EUR", "GBP"), 86.4)
        self.assertEqual(await convert(cache, 40, "GBP", "EUR"), 46.3)
        self.assertEqual(sorted(loader.calls), ["EUR", "GBP"])


if __name__ == "__main__":
    unittest.main()
