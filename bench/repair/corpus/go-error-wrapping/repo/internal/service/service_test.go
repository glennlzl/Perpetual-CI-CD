package service

import (
	"context"
	"errors"
	"testing"

	"example.com/stockroom/internal/store"
)

func TestItem(t *testing.T) {
	svc := New(store.NewMemory(map[string]int{"widget": 5}))
	item, err := svc.Item(context.Background(), "widget")
	if err != nil {
		t.Fatalf("Item(widget): %v", err)
	}
	if want := (store.Item{SKU: "widget", Stock: 5}); item != want {
		t.Errorf("Item(widget) = %+v, want %+v", item, want)
	}
}

func TestReserve(t *testing.T) {
	svc := New(store.NewMemory(map[string]int{"widget": 5}))
	item, err := svc.Reserve(context.Background(), "widget", 2)
	if err != nil {
		t.Fatalf("Reserve(widget, 2): %v", err)
	}
	if item.Stock != 3 {
		t.Errorf("Reserve(widget, 2) left %d in stock, want 3", item.Stock)
	}
}

func TestReserveRejectsQuantitiesBelowOne(t *testing.T) {
	svc := New(store.NewMemory(map[string]int{"widget": 5}))
	for _, qty := range []int{0, -2} {
		if _, err := svc.Reserve(context.Background(), "widget", qty); !errors.Is(err, ErrBadQuantity) {
			t.Errorf("Reserve(widget, %d) error = %v, want ErrBadQuantity", qty, err)
		}
	}
}
