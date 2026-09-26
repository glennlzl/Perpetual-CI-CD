"""Test doubles for RateCache: a clock the test moves, and loaders that record their calls."""
import asyncio


class FakeClock:
    """A monotonic clock that moves only when the test advances it."""

    def __init__(self, now=1000.0):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class TableLoader:
    """Loads at once from a table of rates, recording each call; a currency mapped to an exception raises it."""

    def __init__(self, table):
        self.table = dict(table)
        self.calls = []

    async def __call__(self, currency):
        self.calls.append(currency)
        rate = self.table[currency]
        if isinstance(rate, Exception):
            raise rate
        return rate


class GatedLoader:
    """Loads that wait at a gate per currency until the test opens it, so the test decides every interleaving.

    calls lists the loads in the order they started. release() and fail() open a currency's gate for every load
    waiting there; the next load of that currency waits at a new gate.
    """

    def __init__(self):
        self.calls = []
        self._gates = {}

    def _gate(self, currency):
        if currency not in self._gates:
            self._gates[currency] = (asyncio.Event(), [])
        return self._gates[currency]

    async def __call__(self, currency):
        self.calls.append(currency)
        started, waiting = self._gate(currency)
        result = asyncio.get_running_loop().create_future()
        waiting.append(result)
        started.set()
        return await result

    async def started(self, currency):
        """Returns once a load of the currency waits at its gate."""
        await self._gate(currency)[0].wait()

    def release(self, currency, rate):
        """Opens the currency's gate: every load waiting there returns rate."""
        for result in self._gates.pop(currency)[1]:
            if not result.done():
                result.set_result(rate)

    def fail(self, currency, error):
        """Opens the currency's gate: every load waiting there raises error."""
        for result in self._gates.pop(currency)[1]:
            if not result.done():
                result.set_exception(error)
