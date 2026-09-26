"""Invoices from CSV exports with one row per line item."""

import csv
from decimal import Decimal

from .models import Invoice, LineItem

COLUMNS = ("invoice", "customer", "region", "description", "unit_price", "quantity")


def load_invoices(path) -> list[Invoice]:
    """The invoices of a CSV export, in the order their first rows appear."""
    invoices: dict[str, Invoice] = {}
    with open(path, newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        missing = [column for column in COLUMNS if column not in (reader.fieldnames or ())]
        if missing:
            raise ValueError(f"{path} lacks the columns {', '.join(missing)}")
        for row in reader:
            number = row["invoice"].strip()
            if number not in invoices:
                invoices[number] = Invoice(number, row["customer"].strip(), row["region"].strip())
            item = LineItem(row["description"].strip(), Decimal(row["unit_price"]), int(row["quantity"]))
            invoices[number].items.append(item)
    return list(invoices.values())
