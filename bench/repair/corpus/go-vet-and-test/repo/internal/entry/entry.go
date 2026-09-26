// Package entry reads shifts, one per line: person,date,start,end, such as ana,2026-03-14,09:00,17:30.
package entry

import (
	"bufio"
	"fmt"
	"io"
	"strings"
	"time"
)

// Entry is one shift: who worked, on which day, and from when to when, as times of that day.
type Entry struct {
	Person string
	Date   time.Time     // the day, at midnight UTC
	Start  time.Duration // since midnight
	End    time.Duration // since midnight, after Start
}

// Duration is how long the shift lasted.
func (e Entry) Duration() time.Duration { return e.End - e.Start }

// Parse reads one line: person,date,start,end, with the date as 2006-01-02 and the times as 15:04.
func Parse(line string) (Entry, error) {
	fields := strings.Split(line, ",")
	if len(fields) != 4 {
		return Entry{}, fmt.Errorf("want person,date,start,end, got %q", line)
	}
	for i := range fields {
		fields[i] = strings.TrimSpace(fields[i])
	}
	if fields[0] == "" {
		return Entry{}, fmt.Errorf("no person in %q", line)
	}
	date, err := time.Parse(time.DateOnly, fields[1])
	if err != nil {
		return Entry{}, fmt.Errorf("bad date %q", fields[1])
	}
	start, err := clock(fields[2])
	if err != nil {
		return Entry{}, err
	}
	end, err := clock(fields[3])
	if err != nil {
		return Entry{}, err
	}
	if end <= start {
		return Entry{}, fmt.Errorf("shift ends at %s, not after it starts at %s", fields[3], fields[2])
	}
	return Entry{Person: fields[0], Date: date, Start: start, End: end}, nil
}

// clock is a time of day, 15:04, as the time since midnight.
func clock(value string) (time.Duration, error) {
	t, err := time.Parse("15:04", value)
	if err != nil {
		return 0, fmt.Errorf("bad time %q", value)
	}
	return time.Duration(t.Hour())*time.Hour + time.Duration(t.Minute())*time.Minute, nil
}

// ParseAll reads every line of r, skipping blank lines and lines starting with #. An error names its line.
func ParseAll(r io.Reader) ([]Entry, error) {
	var entries []Entry
	scanner := bufio.NewScanner(r)
	for number := 1; scanner.Scan(); number++ {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		e, err := Parse(line)
		if err != nil {
			return nil, fmt.Errorf("line %d: %w", number, err)
		}
		entries = append(entries, e)
	}
	return entries, scanner.Err()
}
