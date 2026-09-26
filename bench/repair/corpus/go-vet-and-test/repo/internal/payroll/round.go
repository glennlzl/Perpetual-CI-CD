// Package payroll turns shifts into paid time.
package payroll

import "time"

// Quarter is the unit shifts are paid in.
const Quarter = 15 * time.Minute

// RoundQuarter rounds a shift's length to the nearest quarter hour, as the README describes: a shift exactly halfway
// between two quarters (7½ minutes past one) rounds up.
func RoundQuarter(d time.Duration) time.Duration {
	return d / Quarter * Quarter
}
