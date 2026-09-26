// Package store keeps stock levels by SKU.
package store

import (
	"context"
	"errors"
)

// Errors a Store reports, wrapped with the SKU they concern; test for them with errors.Is.
var (
	ErrNotFound     = errors.New("not found")
	ErrInsufficient = errors.New("insufficient stock")
)

// Item is a SKU and the units of it in stock.
type Item struct {
	SKU   string `json:"sku"`
	Stock int    `json:"stock"`
}

// Store reads and reserves stock.
type Store interface {
	// Get returns the item, or an error matching ErrNotFound.
	Get(ctx context.Context, sku string) (Item, error)
	// Reserve takes qty units out of stock and returns the item with what remains, or an error matching
	// ErrNotFound or ErrInsufficient.
	Reserve(ctx context.Context, sku string, qty int) (Item, error)
}
