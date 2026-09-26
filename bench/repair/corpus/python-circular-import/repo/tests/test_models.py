import unittest
from decimal import Decimal

from tally.models import Invoice, LineItem


class InvoiceTest(unittest.TestCase):
    def test_subtotal_adds_the_line_amounts(self):
        items = [LineItem("Widget", Decimal("2.50"), 4), LineItem("Gadget", Decimal("10.00"))]
        self.assertEqual(Invoice("T-1", "Test", "NY", items).subtotal, Decimal("20.00"))

    def test_total_adds_the_sales_tax(self):
        invoice = Invoice("T-2", "Test", "CA", [LineItem("Desk", Decimal("100.00"))])
        self.assertEqual(invoice.total, Decimal("107.25"))

    def test_tax_free_region(self):
        invoice = Invoice("T-3", "Test", "OR", [LineItem("Desk", Decimal("100.00"))])
        self.assertEqual(invoice.total, Decimal("100.00"))


if __name__ == "__main__":
    unittest.main()
