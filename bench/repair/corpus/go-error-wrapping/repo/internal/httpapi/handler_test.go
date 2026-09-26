package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"example.com/stockroom/internal/service"
	"example.com/stockroom/internal/store"
)

// newAPI returns the handler over a fresh store holding 5 widgets and 2 gadgets.
func newAPI() http.Handler {
	return New(service.New(store.NewMemory(map[string]int{"widget": 5, "gadget": 2})))
}

func serve(api http.Handler, method, target, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	api.ServeHTTP(rec, httptest.NewRequest(method, target, strings.NewReader(body)))
	return rec
}

// expect checks a response's status, and its body unless body is empty.
func expect(t *testing.T, rec *httptest.ResponseRecorder, request string, status int, body string) {
	t.Helper()
	got := strings.TrimSpace(rec.Body.String())
	if rec.Code != status {
		t.Fatalf("%s: status = %d, want %d; body = %s", request, rec.Code, status, got)
	}
	if body != "" && got != body {
		t.Errorf("%s: body = %s, want %s", request, got, body)
	}
}

func TestGetItem(t *testing.T) {
	expect(t, serve(newAPI(), http.MethodGet, "/items/widget", ""), "GET /items/widget", http.StatusOK, `{"sku":"widget","stock":5}`)
}

func TestGetUnknownSKU(t *testing.T) {
	expect(t, serve(newAPI(), http.MethodGet, "/items/nope", ""), "GET /items/nope", http.StatusNotFound, "")
}

func TestReserve(t *testing.T) {
	api := newAPI()
	expect(t, serve(api, http.MethodPost, "/items/widget/reserve", `{"qty":2}`), "POST /items/widget/reserve", http.StatusOK, `{"sku":"widget","stock":3}`)
	expect(t, serve(api, http.MethodGet, "/items/widget", ""), "GET /items/widget", http.StatusOK, `{"sku":"widget","stock":3}`)
}

func TestReserveBadQuantity(t *testing.T) {
	expect(t, serve(newAPI(), http.MethodPost, "/items/gadget/reserve", `{"qty":-1}`), "POST /items/gadget/reserve", http.StatusBadRequest, "")
}

func TestReserveMalformedBody(t *testing.T) {
	expect(t, serve(newAPI(), http.MethodPost, "/items/gadget/reserve", `{"qty":`), "POST /items/gadget/reserve", http.StatusBadRequest, "")
}
