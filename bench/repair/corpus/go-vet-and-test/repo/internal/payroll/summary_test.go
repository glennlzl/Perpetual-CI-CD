package payroll

import (
	"slices"
	"testing"
	"time"

	"example.com/timesheet/internal/entry"
)

func TestTotals(t *testing.T) {
	day := time.Date(2026, 3, 9, 0, 0, 0, 0, time.UTC)
	totals := Totals([]entry.Entry{
		{Person: "ana", Date: day, Start: 9 * time.Hour, End: 17 * time.Hour},
		{Person: "ben", Date: day, Start: 13 * time.Hour, End: 17*time.Hour + 30*time.Minute},
		{Person: "ana", Date: day.AddDate(0, 0, 1), Start: 9 * time.Hour, End: 12*time.Hour + 45*time.Minute},
	})
	want := []Total{{Person: "ana", Shifts: 2, Paid: 11*time.Hour + 45*time.Minute}, {Person: "ben", Shifts: 1, Paid: 4*time.Hour + 30*time.Minute}}
	if !slices.Equal(totals, want) {
		t.Errorf("Totals() = %+v, want %+v", totals, want)
	}
}

func TestHours(t *testing.T) {
	if got := Hours(7*time.Hour + 45*time.Minute); got != "7.75" {
		t.Errorf("Hours(7h45m) = %q, want \"7.75\"", got)
	}
}
