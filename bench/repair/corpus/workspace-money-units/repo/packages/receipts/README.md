# @acme/receipts

`receipt(order)` is the text of an order's receipt. An order is `{ number, currency, lines }`, and each line
`{ sku, price, qty }` has its unit price as a decimal string, as the catalog lists it. Amounts are formatted with
`@acme/money`:

```
Receipt R-1001
2 × BOOK @ $12.50  $25.00
1 × PEN @ $19.99  $19.99
Total  $44.99
```
