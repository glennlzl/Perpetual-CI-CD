// Package httpapi serves the stockroom over HTTP.
package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"example.com/stockroom/internal/service"
	"example.com/stockroom/internal/store"
)

// New returns the stockroom's HTTP handler:
//
//	GET  /items/{sku}          the item and its stock
//	POST /items/{sku}/reserve  {"qty": n} takes n units out of stock
func New(svc *service.Service) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /items/{sku}", func(w http.ResponseWriter, r *http.Request) {
		item, err := svc.Item(r.Context(), r.PathValue("sku"))
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, item)
	})
	mux.HandleFunc("POST /items/{sku}/reserve", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Qty int `json:"qty"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "malformed body"})
			return
		}
		item, err := svc.Reserve(r.Context(), r.PathValue("sku"), body.Qty)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, item)
	})
	return mux
}

// writeError answers with the status an error calls for: 404 for an unknown SKU, 409 for too little stock, 400 for a
// bad quantity, and 500 for anything else, whose message stays on the server.
func writeError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
	case errors.Is(err, store.ErrInsufficient):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	case errors.Is(err, service.ErrBadQuantity):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
	default:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
	}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
