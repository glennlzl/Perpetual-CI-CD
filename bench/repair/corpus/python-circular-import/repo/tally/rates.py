"""Sales tax rates by region, as fractions of the taxable amount."""

from decimal import Decimal

RATES = {
    "CA": Decimal("0.0725"),
    "CO": Decimal("0.029"),
    "IL": Decimal("0.0625"),
    "IN": Decimal("0.07"),
    "NY": Decimal("0.04"),
    "OR": Decimal("0"),
    "TX": Decimal("0.0625"),
    "WA": Decimal("0.065"),
    "WI": Decimal("0.05"),
}
