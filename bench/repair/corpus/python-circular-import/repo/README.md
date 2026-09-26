# tally

Invoice totals from CSV exports, with sales tax by region.

```sh
python -m tally.cli invoices.csv
```

prints each invoice's subtotal, tax and tax-inclusive total, then the grand total. An export has one row per line item,
with the columns `invoice,customer,region,description,unit_price,quantity`.

In code:

```python
from tally.csvio import load_invoices
from tally.models import Invoice, LineItem
from tally.pricing import price_invoice, tax_for
```

- `tax_for(region, amount)`: the sales tax on a `Decimal` amount, rounded half up to the cent. An unknown region raises
  `ValueError`. The rates are in `tally/rates.py`.
- `Invoice.subtotal` and `Invoice.total`: the line amounts before tax, and the subtotal plus the region's sales tax.
- `price_invoice(invoice)`: `{"subtotal": …, "tax": …, "total": …}`.

Tests: `python -m unittest discover -s tests -t .`
