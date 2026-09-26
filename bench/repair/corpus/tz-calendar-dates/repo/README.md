# stays

Quotes hotel stays for the booking page.

- `quoteStay({ checkIn, checkOut, rates })` prices each night from check-in up to check-out, in cents: Friday and Saturday nights at `rates.weekend`, the others at `rates.weekday`.
- `formatStay({ checkIn, checkOut })` labels a stay: `Fri 6 Mar – Mon 9 Mar (3 nights)`.

Dates are calendar dates, `YYYY-MM-DD`, with no time of day and no time zone: a stay from 6 March is from 6 March wherever the server runs.
