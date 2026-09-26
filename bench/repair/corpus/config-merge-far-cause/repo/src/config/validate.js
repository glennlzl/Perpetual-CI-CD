// Checks the merged configuration before the service uses it.

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCents = value => Number.isInteger(value) && value >= 0;

/** The configuration, when every setting is usable; otherwise throws an Error naming the first that is not. */
export function validateConfig(config) {
  const fail = (path, problem) => { throw new Error(`Invalid config: ${path} ${problem}.`); };
  const port = config.server?.port;
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail('server.port', 'must be a port number');
  const maxLines = config.orders?.maxLines;
  if (!Number.isInteger(maxLines) || maxLines < 1) fail('orders.maxLines', 'must be a whole number from 1');
  if (!isObject(config.regions) || !Object.keys(config.regions).length) fail('regions', 'must name a region');
  for (const [name, region] of Object.entries(config.regions)) {
    if (!isObject(region)) fail(`regions.${name}`, 'must be an object');
    if (region.currency !== undefined && !/^[A-Z]{3}$/.test(region.currency)) fail(`regions.${name}.currency`, 'must be a three-letter code');
    if (region.tax !== undefined) {
      if (typeof region.tax?.rate !== 'number' || region.tax.rate < 0 || region.tax.rate >= 1) fail(`regions.${name}.tax.rate`, 'must be a fraction from 0 to 1');
      if (region.tax.shipping !== undefined && typeof region.tax.shipping !== 'boolean') fail(`regions.${name}.tax.shipping`, 'must be true or false');
    }
    if (region.shipping !== undefined) {
      if (!isCents(region.shipping?.flat)) fail(`regions.${name}.shipping.flat`, 'must be whole cents');
      if (region.shipping.freeFrom !== undefined && !isCents(region.shipping.freeFrom)) fail(`regions.${name}.shipping.freeFrom`, 'must be whole cents');
    }
  }
  return config;
}
