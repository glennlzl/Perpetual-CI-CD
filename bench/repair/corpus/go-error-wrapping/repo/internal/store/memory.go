package store

import (
	"context"
	"fmt"
	"sync"
)

// Memory is a Store in memory, safe for concurrent use.
type Memory struct {
	mu    sync.Mutex
	stock map[string]int
}

var _ Store = (*Memory)(nil)

// NewMemory returns a Memory holding a copy of stock, in units by SKU.
func NewMemory(stock map[string]int) *Memory {
	m := &Memory{stock: make(map[string]int, len(stock))}
	for sku, units := range stock {
		m.stock[sku] = units
	}
	return m
}

// Get returns the item with the given SKU.
func (m *Memory) Get(_ context.Context, sku string) (Item, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	units, ok := m.stock[sku]
	if !ok {
		return Item{}, fmt.Errorf("sku %q: %v", sku, ErrNotFound)
	}
	return Item{SKU: sku, Stock: units}, nil
}

// Reserve takes qty units of the SKU out of stock.
func (m *Memory) Reserve(_ context.Context, sku string, qty int) (Item, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	units, ok := m.stock[sku]
	if !ok {
		return Item{}, fmt.Errorf("sku %q: %v", sku, ErrNotFound)
	}
	if qty > units {
		return Item{}, fmt.Errorf("sku %q: want %d, have %d: %v", sku, qty, units, ErrInsufficient)
	}
	m.stock[sku] = units - qty
	return Item{SKU: sku, Stock: units - qty}, nil
}
