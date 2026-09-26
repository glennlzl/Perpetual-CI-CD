// Package export writes the payroll export: one CSV row per shift with the person, the date and the paid hours.
package export

import (
	"encoding/csv"
	"io"

	"example.com/timesheet/internal/entry"
	"example.com/timesheet/internal/payroll"
)

// Header is the export's first row.
var Header = []string{"person", "date", "hours"}

// CSV writes the export of entries to w: the header, then one row per shift with its date as an ISO 8601 day
// (2026-03-14) and its paid hours, rounded to the nearest quarter hour, with two decimals.
func CSV(w io.Writer, entries []entry.Entry) error {
	out := csv.NewWriter(w)
	if err := out.Write(Header); err != nil {
		return err
	}
	for _, e := range entries {
		row := []string{e.Person, e.Date.Format("2006-02-01"), payroll.Hours(payroll.RoundQuarter(e.Duration()))}
		if err := out.Write(row); err != nil {
			return err
		}
	}
	out.Flush()
	return out.Error()
}
