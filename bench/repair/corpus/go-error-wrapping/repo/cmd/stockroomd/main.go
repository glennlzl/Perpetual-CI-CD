// Command stockroomd serves the stockroom over HTTP.
package main

import (
	"log"
	"net/http"
	"os"

	"example.com/stockroom/internal/httpapi"
	"example.com/stockroom/internal/service"
	"example.com/stockroom/internal/store"
)

func main() {
	addr := os.Getenv("STOCKROOM_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	stock := store.NewMemory(map[string]int{"widget": 12, "gadget": 3, "sprocket": 40})
	log.Printf("stockroomd listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, httpapi.New(service.New(stock))))
}
