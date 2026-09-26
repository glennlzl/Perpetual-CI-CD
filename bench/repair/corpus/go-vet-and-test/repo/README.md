# timesheet

Turns shifts into paid hours for payroll.

Each line of input is one shift, `person,date,start,end`, such as `ana,2026-03-14,09:00,17:30`. Blank lines and lines
starting with `#` are skipped.

- Paid time: each shift is rounded to the nearest quarter hour before anything is added up. A shift exactly halfway
  between two quarters, 7½ minutes past one, rounds up.
- `timesheet` prints each person's paid hours. `timesheet -csv` writes the payroll export: `person,date,hours`, one row
  per shift, with ISO 8601 dates (`2026-03-14`) and hours with two decimals (`7.75`).

```sh
go run ./cmd/timesheet -csv < shifts.csv
```
