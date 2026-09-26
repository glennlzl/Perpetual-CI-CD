package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"example.com/stockroom/internal/store"
)

// holdoutCheck checks that err matches sentinel and names sku.
func holdoutCheck(t *testing.T, call string, err, sentinel error, sku string) {
	t.Helper()
	if !errors.Is(err, sentinel) {
		t.Errorf("%s: error %v does not match %v", call, err, sentinel)
	}
	if err != nil && !strings.Contains(err.Error(), sku) {
		t.Errorf("%s: error %q does not name %s", call, err.Error(), sku)
	}
}

func TestHoldoutServiceErrorsMatchTheStoreSentinels(t *testing.T) {
	ctx := context.Background()
	svc := New(store.NewMemory(map[string]int{"bolt": 4}))
	_, err := svc.Item(ctx, "rivet")
	holdoutCheck(t, "Item(rivet)", err, store.ErrNotFound, "rivet")
	_, err = svc.Reserve(ctx, "rivet", 1)
	holdoutCheck(t, "Reserve(rivet, 1)", err, store.ErrNotFound, "rivet")
	_, err = svc.Reserve(ctx, "bolt", 5)
	holdoutCheck(t, "Reserve(bolt, 5)", err, store.ErrInsufficient, "bolt")
}

func TestHoldoutStoreErrorsNameTheirSKU(t *testing.T) {
	ctx := context.Background()
	m := store.NewMemory(map[string]int{"bolt": 4})
	_, err := m.Get(ctx, "rivet")
	holdoutCheck(t, "Memory.Get(rivet)", err, store.ErrNotFound, "rivet")
	_, err = m.Reserve(ctx, "rivet", 1)
	holdoutCheck(t, "Memory.Reserve(rivet, 1)", err, store.ErrNotFound, "rivet")
	_, err = m.Reserve(ctx, "bolt", 5)
	holdoutCheck(t, "Memory.Reserve(bolt, 5)", err, store.ErrInsufficient, "bolt")
}
