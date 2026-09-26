/** Shipping in cents for an item total in a region: free from its freeFrom, else its flat charge; none without a section. */
export function shippingCents(region, itemsCents) {
  const { shipping } = region;
  if (!shipping) return 0;
  return shipping.freeFrom !== undefined && itemsCents >= shipping.freeFrom ? 0 : shipping.flat;
}
