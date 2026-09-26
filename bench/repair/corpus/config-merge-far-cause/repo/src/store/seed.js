/** The catalog and discount codes a new store starts with. Prices are in cents. */
export const SEED = {
  products: [
    { sku: 'mug', name: 'Mug', unitCents: 2500 },
    { sku: 'tee', name: 'T-shirt', unitCents: 1800 },
    { sku: 'cap', name: 'Cap', unitCents: 1350 },
    { sku: 'tote', name: 'Tote bag', unitCents: 1100 },
    { sku: 'sticker', name: 'Sticker', unitCents: 250 },
  ],
  codes: [
    { code: 'WELCOME5', percent: 5 },
    { code: 'SPRING15', percent: 15, minimumCents: 3000 },
  ],
};
