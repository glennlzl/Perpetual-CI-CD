const DECIMAL = ['B', 'KB', 'MB', 'GB', 'TB'], BINARY = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

/** A byte count as text with at most one decimal: 1536 is "1.5 KB" in powers of 1000, or "1.5 KiB" with binary. */
export function formatSize(bytes, { binary = false } = {}) {
  const base = binary ? 1024 : 1000, units = binary ? BINARY : DECIMAL;
  let value = bytes, unit = 0;
  while (Math.abs(value) >= base && unit < units.length - 1) { value /= base; unit += 1; }
  return `${unit ? Number(value.toFixed(1)) : value} ${units[unit]}`;
}
