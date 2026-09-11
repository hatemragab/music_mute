import { adminError } from '../admin/admin-errors.js';

export type CsvCell = string | number | null;
export const MAX_CSV_BYTES = 8 * 1024 * 1024;

export function csvCell(value: CsvCell): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('CSV number must be finite');
    return String(value);
  }
  let literal = value ?? '';
  if (/^[\s\uFEFF]*[=+@-]/u.test(literal) || /^[\t\r\n]/u.test(literal))
    literal = `'${literal}`;
  return `"${literal.replaceAll('"', '""')}"`;
}

export function encodeCsv(
  headers: readonly string[],
  rows: readonly (readonly CsvCell[])[],
): string {
  const chunks = [`${headers.join(',')}\r\n`];
  let bytes = Buffer.byteLength(chunks[0]!, 'utf8');
  for (const row of rows) {
    if (row.length !== headers.length)
      throw new TypeError('Invalid CSV column count');
    const line = `${row.map(csvCell).join(',')}\r\n`;
    bytes += Buffer.byteLength(line, 'utf8');
    if (bytes > MAX_CSV_BYTES) throw adminError('EXPORT_TOO_LARGE');
    chunks.push(line);
  }
  return chunks.join('');
}
