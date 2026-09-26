package store

import (
	"context"
	"testing"
)

func TestMemoryGet(t *testing.T) {
	m := NewMemory(map[string]int{"widget": 5})
	item, err := m.Get(context.Background(), "widget")
	if err != nil {
		t.Fatalf("Get(widget): %v", err)
	}
	if want := (Item{SKU: "widget", Stock: 5}); item != want {
		t.Errorf("Get(widget) = %+v, want %+v", item, want)
	}
}

func TestMemoryReserve(t *testing.T) {
	ctx := context.Background()
	m := NewMemory(map[string]int{"widget": 5})
	item, err := m.Reserve(ctx, "widget", 2)
	if err != nil {
		t.Fatalf("Reserve(widget, 2): %v", err)
	}
	if item.Stock != 3 {
		t.Errorf("Reserve(widget, 2) left %d in stock, want 3", item.Stock)
	}
	if item, err = m.Reserve(ctx, "widget", 3); err != nil || item.Stock != 0 {
		t.Errorf("Reserve(widget, 3) = %+v, %v; want 0 left", item, err)
	}
}

func TestNewMemoryCopiesItsInput(t *testing.T) {
	stock := map[string]int{"widget": 5}
	m := NewMemory(stock)
	stock["widget"] = 1
	if item, err := m.Get(context.Background(), "widget"); err != nil || item.Stock != 5 {
		t.Errorf("Get(widget) = %+v, %v; want 5 in stock", item, err)
	}
}
