package payroll

import (
	"strconv"
	"time"

	"example.com/timesheet/internal/entry"
)

// Total is one person's paid time over their shifts.
type Total struct {
	Person string
	Shifts int
	Paid   time.Duration
}

// Totals adds up each person's paid time, every shift rounded to the nearest quarter hour first, in the order people
// first appear.
func Totals(entries []entry.Entry) []Total {
	var totals []Total
	index := map[string]int{}
	for _, e := range entries {
		i, ok := index[e.Person]
		if !ok {
			i = len(totals)
			index[e.Person] = i
			totals = append(totals, Total{Person: e.Person})
		}
		totals[i].Shifts++
		totals[i].Paid += RoundQuarter(e.Duration())
	}
	return totals
}

// Hours is paid time in decimal hours with two decimals, as payroll reads it: 7h45m is 7.75.
func Hours(d time.Duration) string {
	return strconv.FormatFloat(d.Hours(), 'f', 2, 64)
}
