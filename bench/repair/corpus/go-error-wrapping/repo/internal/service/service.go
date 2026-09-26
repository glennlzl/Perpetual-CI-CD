// Package service applies the stockroom's rules on top of a store.
package service

import (
	"context"
	"errors"
	"fmt"

	"example.com/stockroom/internal/store"
)

// ErrBadQuantity is the error for a reservation of fewer than one unit.
var ErrBadQuantity = errors.New("quantity must be at least 1")

// Service reads and reserves stock through a store.Store.
type Service struct {
	store store.Store
}

// New returns a Service over s.
func New(s store.Store) *Service {
	return &Service{store: s}
}

// Item returns the item with the given SKU.
func (s *Service) Item(ctx context.Context, sku string) (store.Item, error) {
	item, err := s.store.Get(ctx, sku)
	if err != nil {
		return store.Item{}, fmt.Errorf("item %s: %w", sku, err)
	}
	return item, nil
}

// Reserve takes qty units of the SKU out of stock and returns the item with what remains.
func (s *Service) Reserve(ctx context.Context, sku string, qty int) (store.Item, error) {
	if qty < 1 {
		return store.Item{}, ErrBadQuantity
	}
	item, err := s.store.Reserve(ctx, sku, qty)
	if err != nil {
		return store.Item{}, fmt.Errorf("reserve %d of %s: %v", qty, sku, err)
	}
	return item, nil
}
