import unittest
from decimal import Decimal
from pathlib import Path

from tally.csvio import load_invoices
from tally.models import Invoice, LineItem
from tally.pricing import price_invoice, tax_for

APRIL = Path(__file__).parent / "data" / "april.csv"


class TaxTest(unittest.TestCase):
    def test_rounds_half_up_to_the_cent(self):
        self.assertEqual(tax_for("CA", Decimal("491.00")), Decimal("35.60"))
        self.assertEqual(tax_for("TX", Decimal("0.08")), Decimal("0.01"))

    def test_unknown_region(self):
        with self.assertRaises(ValueError):
            tax_for("ZZ", Decimal("1.00"))


class PriceInvoiceTest(unittest.TestCase):
    def test_breakdown(self):
        invoice = Invoice("T-4", "Test", "NY", [LineItem("Monitor arm", Decimal("89.99"), 3)])
        expected = {"subtotal": Decimal("269.97"), "tax": Decimal("10.80"), "total": Decimal("280.77")}
        self.assertEqual(price_invoice(invoice), expected)

    def test_april_export(self):
        totals = [price_invoice(invoice)["total"] for invoice in load_invoices(APRIL)]
        self.assertEqual(totals, [Decimal("526.60"), Decimal("280.77"), Decimal("45.00"), Decimal("65.88")])


if __name__ == "__main__":
    unittest.main()
