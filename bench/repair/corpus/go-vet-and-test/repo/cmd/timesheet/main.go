// Command timesheet reads shifts from standard input and prints each person's paid hours, or with -csv the payroll
// export.
package main

import (
	"flag"
	"fmt"
	"os"

	"example.com/timesheet/internal/entry"
	"example.com/timesheet/internal/export"
	"example.com/timesheet/internal/payroll"
)

func main() {
	asCSV := flag.Bool("csv", false, "write the payroll export as CSV")
	flag.Parse()
	entries, err := entry.ParseAll(os.Stdin)
	if err != nil {
		fmt.Fprintln(os.Stderr, "timesheet:", err)
		os.Exit(1)
	}
	if *asCSV {
		if err := export.CSV(os.Stdout, entries); err != nil {
			fmt.Fprintln(os.Stderr, "timesheet:", err)
			os.Exit(1)
		}
		return
	}
	for _, total := range payroll.Totals(entries) {
		fmt.Printf("%s\t%s\n", total.Person, payroll.Hours(total.Paid))
	}
}
