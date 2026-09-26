"""Invoices and their line items."""

from dataclasses import dataclass, field
from decimal import Decimal

from .pricing import tax_for


@dataclass(frozen=True)
class LineItem:
    """One line of an invoice: what was sold, its unit price and how many."""

    description: str
    unit_price: Decimal
    quantity: int = 1

    @property
    def amount(self) -> Decimal:
        """The unit price times the quantity."""
        return self.unit_price * self.quantity


@dataclass
class Invoice:
    """An invoice to a customer, taxed at the rate of its region."""

    number: str
    customer: str
    region: str
    items: list[LineItem] = field(default_factory=list)

    @property
    def subtotal(self) -> Decimal:
        """The line amounts added up, before tax."""
        return sum((item.amount for item in self.items), Decimal("0.00"))

    @property
    def total(self) -> Decimal:
        """What the customer pays: the subtotal plus the region's sales tax."""
        return self.subtotal + tax_for(self.region, self.subtotal)
