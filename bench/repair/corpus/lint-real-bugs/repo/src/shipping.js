/** Shipping in cents to a region: 'domestic' 499, 'eu' and 'eea' 999, 'intl' 1999. Any other region throws. */
export function shippingFor(region) {
  let cents;
  switch (region) {
    case 'domestic':
      cents = 499;
      break;
    case 'eea':
    case 'eu':
      cents = 999;
    case 'intl':
      cents = 1999;
      break;
    default:
      throw new Error(`Unknown region: ${region}`);
  }
  return cents;
}
