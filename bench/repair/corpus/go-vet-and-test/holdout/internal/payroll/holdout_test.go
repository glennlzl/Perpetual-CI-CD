package payroll

import (
	"testing"
	"time"

	"example.com/timesheet/internal/entry"
)

func TestHoldoutRoundQuarterRoundsToTheNearestQuarter(t *testing.T) {
	for _, c := range []struct{ shift, want time.Duration }{
		{0, 0},
		{7*time.Minute + 29*time.Second, 0},
		{7*time.Minute + 30*time.Second, 15 * time.Minute},
		{22*time.Minute + 30*time.Second, 30 * time.Minute},
		{7*time.Hour + 52*time.Minute + 29*time.Second, 7*time.Hour + 45*time.Minute},
		{7*time.Hour + 52*time.Minute + 30*time.Second, 8 * time.Hour},
		{8 * time.Hour, 8 * time.Hour},
	} {
		if got := RoundQuarter(c.shift); got != c.want {
			t.Errorf("RoundQuarter(%v) = %v, want %v", c.shift, got, c.want)
		}
	}
}

func TestHoldoutTotalsRoundEachShiftFirst(t *testing.T) {
	day := time.Date(2026, 5, 4, 0, 0, 0, 0, time.UTC)
	totals := Totals([]entry.Entry{
		{Person: "cy", Date: day, Start: 9 * time.Hour, End: 16*time.Hour + 53*time.Minute},
		{Person: "dee", Date: day, Start: 8 * time.Hour, End: 12*time.Hour + 7*time.Minute},
		{Person: "cy", Date: day.AddDate(0, 0, 1), Start: 9 * time.Hour, End: 16*time.Hour + 53*time.Minute},
	})
	want := []Total{{Person: "cy", Shifts: 2, Paid: 16 * time.Hour}, {Person: "dee", Shifts: 1, Paid: 4 * time.Hour}}
	if len(totals) != len(want) {
		t.Fatalf("Totals() = %+v, want %+v", totals, want)
	}
	for i := range want {
		if totals[i] != want[i] {
			t.Errorf("Totals()[%d] = %+v, want %+v", i, totals[i], want[i])
		}
	}
	if got := Hours(totals[0].Paid); got != "16.00" {
		t.Errorf("Hours(%v) = %q, want \"16.00\"", totals[0].Paid, got)
	}
}
