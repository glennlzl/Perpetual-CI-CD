export interface Row { sku: string; quantity: number }

function quantity(cell: string, line: number): number {
  if (!/^\d+$/.test(cell.trim())) throw new Error(`Malformed line ${line}`);
  return Number(cell);
}

/** Rows of "sku,quantity" text, one per line. Blank lines are skipped; a malformed line throws `Malformed line N`. */
export function parseCsv(text: string): Row[] {
  const rows: Row[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    const cells = line.split(',');
    rows.push({ sku: cells[0].trim(), quantity: quantity(cells[1], index + 1) });
  }
  return rows;
}
