package export

import (
	"strings"
	"testing"
	"time"

	"example.com/timesheet/internal/entry"
)

func TestCSV(t *testing.T) {
	var b strings.Builder
	err := CSV(&b, []entry.Entry{{Person: "ana", Date: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), Start: 9 * time.Hour, End: 17*time.Hour + 30*time.Minute}})
	if err != nil {
		t.Fatal(err)
	}
	if want := "person,date,hours\nana,2026-01-01,8.50\n"; b.String() != want {
		t.Errorf("CSV() = %q, want %q", b.String(), want)
	}
}
