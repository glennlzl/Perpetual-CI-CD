"""Prices invoices: the sales tax of their region, rounded half up to the cent."""

from decimal import ROUND_HALF_UP, Decimal

from .models import Invoice, LineItem
from .rates import RATES

CENT = Decimal("0.01")


def tax_for(region: str, amount: Decimal) -> Decimal:
    """The sales tax on amount in region, rounded half up to the cent. An unknown region raises ValueError."""
    if region not in RATES:
        raise ValueError(f"Unknown region: {region}")
    return (amount * RATES[region]).quantize(CENT, rounding=ROUND_HALF_UP)


def price_line(item: LineItem) -> Decimal:
    """A line's amount."""
    if not isinstance(item, LineItem):
        raise TypeError(f"Expected a LineItem, got {type(item).__name__}")
    return item.amount


def price_invoice(invoice: Invoice) -> dict[str, Decimal]:
    """The invoice's subtotal, sales tax and tax-inclusive total."""
    if not isinstance(invoice, Invoice):
        raise TypeError(f"Expected an Invoice, got {type(invoice).__name__}")
    subtotal = sum((price_line(item) for item in invoice.items), Decimal("0.00"))
    return {"subtotal": subtotal, "tax": tax_for(invoice.region, subtotal), "total": invoice.total}
