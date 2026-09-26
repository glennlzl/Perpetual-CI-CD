package export

import (
	"strings"
	"testing"
	"time"

	"example.com/timesheet/internal/entry"
)

func TestHoldoutCSVWritesISODates(t *testing.T) {
	var b strings.Builder
	err := CSV(&b, []entry.Entry{
		{Person: "ana", Date: time.Date(2026, 3, 14, 0, 0, 0, 0, time.UTC), Start: 9 * time.Hour, End: 17 * time.Hour},
		{Person: "ben", Date: time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC), Start: 13 * time.Hour, End: 21*time.Hour + 15*time.Minute},
	})
	if err != nil {
		t.Fatal(err)
	}
	if want := "person,date,hours\nana,2026-03-14,8.00\nben,2026-12-01,8.25\n"; b.String() != want {
		t.Errorf("CSV() = %q, want %q", b.String(), want)
	}
}
