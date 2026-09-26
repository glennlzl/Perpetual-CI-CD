package entry

import (
	"strings"
	"testing"
	"time"
)

func TestParse(t *testing.T) {
	e, err := Parse("ana, 2026-03-14, 09:00, 17:30")
	if err != nil {
		t.Fatal(err)
	}
	if e.Person != "ana" || !e.Date.Equal(time.Date(2026, 3, 14, 0, 0, 0, 0, time.UTC)) || e.Start != 9*time.Hour || e.End != 17*time.Hour+30*time.Minute {
		t.Errorf("Parse() = %+v, want ana on 2026-03-14 from 9h to 17h30m", e)
	}
	if got := e.Duration(); got != 8*time.Hour+30*time.Minute {
		t.Errorf("Duration() = %v, want 8h30m0s", got)
	}
}

func TestParseRefusesAShiftThatEndsBeforeItStarts(t *testing.T) {
	if _, err := Parse("ana,2026-03-14,17:00,09:00"); err == nil {
		t.Error("Parse() accepted a shift that ends before it starts")
	}
}

func TestParseAllSkipsBlankAndCommentLines(t *testing.T) {
	entries, err := ParseAll(strings.NewReader("# week 11\nana,2026-03-14,09:00,17:00\n\nben,2026-03-14,13:00,21:15\n"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 || entries[0].Person != "ana" || entries[1].Person != "ben" {
		t.Errorf("ParseAll() = %+v, want the shifts of ana and ben", entries)
	}
}

func TestParseAllNamesTheLine(t *testing.T) {
	_, err := ParseAll(strings.NewReader("ana,2026-03-14,09:00,17:00\nben,2026-03-14,9am,5pm\n"))
	if err == nil || !strings.HasPrefix(err.Error(), "line 2: ") {
		t.Errorf("ParseAll() = %v, want an error about line 2", err)
	}
}
