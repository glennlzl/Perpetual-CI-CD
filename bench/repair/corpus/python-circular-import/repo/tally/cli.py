"""Prints each invoice of a CSV export with its tax-inclusive total: python -m tally.cli invoices.csv"""

import sys
from decimal import Decimal

from .pricing import price_invoice
from .csvio import load_invoices


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1:
        print("usage: python -m tally.cli INVOICES.csv", file=sys.stderr)
        return 2
    invoices = load_invoices(args[0])
    grand = Decimal("0.00")
    for invoice in invoices:
        priced = price_invoice(invoice)
        grand += priced["total"]
        print(f"{invoice.number} {invoice.customer}: subtotal {priced['subtotal']}, tax {priced['tax']}, total {priced['total']}")
    print(f"{len(invoices)} invoices, total {grand}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
