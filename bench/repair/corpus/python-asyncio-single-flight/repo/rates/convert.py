"""Currency conversion at cached rates."""
import asyncio


async def convert(cache, amount, source, target):
    """amount of the source currency in the target currency, rounded to cents; both rates load at once."""
    source_rate, target_rate = await asyncio.gather(cache.get(source), cache.get(target))
    return round(amount * source_rate / target_rate, 2)
