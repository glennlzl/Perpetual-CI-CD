package payroll

import (
	"testing"
	"time"
)

func TestRoundQuarter(t *testing.T) {
	for _, c := range []struct{ shift, want time.Duration }{
		{8 * time.Hour, 8 * time.Hour},
		{4*time.Hour + 7*time.Minute, 4 * time.Hour},
		{7*time.Hour + 53*time.Minute, 8 * time.Hour},
	} {
		if got := RoundQuarter(c.shift); got != c.want {
			t.Errorf("RoundQuarter(%v) = %v, want %v", c.shift, got, c.want)
		}
	}
}
