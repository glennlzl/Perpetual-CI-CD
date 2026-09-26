import subprocess
import sys
import unittest
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def python(*args):
    """A fresh interpreter in the repository root, so every module is imported first in its own process."""
    return subprocess.run([sys.executable, *args], cwd=ROOT, capture_output=True, text=True, timeout=120)


class HoldoutImportTest(unittest.TestCase):
    def test_each_module_imports_first_in_a_fresh_interpreter(self):
        for module in ("tally", "tally.models", "tally.pricing", "tally.csvio", "tally.cli", "tally.rates"):
            with self.subTest(module=module):
                result = python("-c", f"import {module}")
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_tax_for_is_still_imported_from_pricing(self):
        result = python("-c", "from decimal import Decimal; from tally.pricing import tax_for; print(tax_for('WI', Decimal('2.50')))")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "0.13")

    def test_cli_prints_every_total(self):
        result = python("-m", "tally.cli", "tests/data/april.csv")
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = result.stdout.splitlines()
        self.assertEqual(lines[-1], "4 invoices, total 918.25")
        for number, total in (("A-1001", "526.60"), ("A-1002", "280.77"), ("A-1003", "45.00"), ("A-1004", "65.88")):
            self.assertTrue(any(line.startswith(f"{number} ") and line.endswith(f"total {total}") for line in lines), result.stdout)


class HoldoutTaxTest(unittest.TestCase):
    def test_rounds_half_up_in_other_regions(self):
        from tally.pricing import tax_for

        self.assertEqual(tax_for("WI", Decimal("2.50")), Decimal("0.13"))
        self.assertEqual(tax_for("WA", Decimal("1.00")), Decimal("0.07"))
        self.assertEqual(tax_for("IL", Decimal("0.08")), Decimal("0.01"))
        self.assertEqual(tax_for("CO", Decimal("19.99")), Decimal("0.58"))

    def test_invoice_totals_in_every_region(self):
        from tally.models import Invoice, LineItem

        expected = {"CA": "21.44", "CO": "20.57", "IL": "21.24", "IN": "21.39", "NY": "20.79", "OR": "19.99", "TX": "21.24", "WA": "21.29", "WI": "20.99"}
        for region, total in expected.items():
            with self.subTest(region=region):
                invoice = Invoice("H-1", "Holdout", region, [LineItem("Kettle", Decimal("19.99"))])
                self.assertEqual(invoice.total, Decimal(total))


if __name__ == "__main__":
    unittest.main()
