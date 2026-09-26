# ledger

`splitCents(total, parts)` splits a bill of `total` cents between `parts` people:

- the shares add up to the total exactly;
- they differ by at most one cent;
- the earlier shares take the extra cents: `splitCents(100, 3)` is `[34, 33, 33]`;
- `parts` below 1, or not a whole number, throws a `RangeError`.
