package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"example.com/stockroom/internal/service"
	"example.com/stockroom/internal/store"
)

// holdoutMissing is another store's error for an unknown SKU: it matches store.ErrNotFound without wrapping it or
// saying "not found".
type holdoutMissing struct{ sku string }

func (e holdoutMissing) Error() string        { return "no item called " + e.sku }
func (e holdoutMissing) Is(target error) bool { return target == store.ErrNotFound }

// holdoutEmptyStore is a store.Store that holds nothing.
type holdoutEmptyStore struct{}

func (holdoutEmptyStore) Get(_ context.Context, sku string) (store.Item, error) {
	return store.Item{}, holdoutMissing{sku: sku}
}

func (holdoutEmptyStore) Reserve(_ context.Context, sku string, _ int) (store.Item, error) {
	return store.Item{}, holdoutMissing{sku: sku}
}

func holdoutStatus(t *testing.T, api http.Handler, method, target, body string, want int) {
	t.Helper()
	rec := httptest.NewRecorder()
	api.ServeHTTP(rec, httptest.NewRequest(method, target, strings.NewReader(body)))
	if rec.Code != want {
		t.Errorf("%s %s %s: status = %d, want %d; body = %s", method, target, body, rec.Code, want, strings.TrimSpace(rec.Body.String()))
	}
}

func TestHoldoutReserveStatuses(t *testing.T) {
	api := New(service.New(store.NewMemory(map[string]int{"sprocket": 7})))
	holdoutStatus(t, api, http.MethodPost, "/items/ghost/reserve", `{"qty":1}`, http.StatusNotFound)
	holdoutStatus(t, api, http.MethodPost, "/items/sprocket/reserve", `{"qty":999}`, http.StatusConflict)
	holdoutStatus(t, api, http.MethodPost, "/items/sprocket/reserve", `{"qty":0}`, http.StatusBadRequest)
	holdoutStatus(t, api, http.MethodPost, "/items/sprocket/reserve", `{"qty":7}`, http.StatusOK)
	holdoutStatus(t, api, http.MethodPost, "/items/sprocket/reserve", `{"qty":1}`, http.StatusConflict)
	holdoutStatus(t, api, http.MethodGet, "/items/ghost", "", http.StatusNotFound)
}

func TestHoldoutAnotherStoresNotFound(t *testing.T) {
	api := New(service.New(holdoutEmptyStore{}))
	holdoutStatus(t, api, http.MethodGet, "/items/sprocket", "", http.StatusNotFound)
	holdoutStatus(t, api, http.MethodPost, "/items/sprocket/reserve", `{"qty":1}`, http.StatusNotFound)
}
