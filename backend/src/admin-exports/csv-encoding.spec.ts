import { describe, expect, it } from 'vitest';
import { encodeCsv, csvCell } from './csv-encoding.js';

describe('CSV export encoding', () => {
  it('quotes comma, quotes, CR/LF and Unicode as UTF-8 with deterministic CRLF', () => {
    expect(
      encodeCsv(
        ['first', 'second'],
        [
          ['a,"b"\r\nc', 'مرحبا'],
          [null, 12.5],
        ],
      ),
    ).toBe('first,second\r\n"a,""b""\r\nc","مرحبا"\r\n"",12.5\r\n');
  });
  it.each([
    '=HYPERLINK("https://bad.invalid")',
    '+SUM(A1)',
    '-1+2',
    '@SUM(A1)',
    '\tvalue',
    '\rvalue',
    '\nvalue',
    '  =1+1',
  ])(
    'neutralizes spreadsheet formula prefix %j before CSV escaping',
    (value) => {
      expect(csvCell(value).startsWith('"\'')).toBe(true);
    },
  );
  it('retains typed numeric and date columns and rejects nonfinite numbers or wrong row width', () => {
    expect(csvCell(-2)).toBe('-2');
    expect(csvCell('2026-09-11T00:00:00.000Z')).toBe(
      '"2026-09-11T00:00:00.000Z"',
    );
    expect(() => csvCell(Infinity)).toThrow();
    expect(() => encodeCsv(['one'], [[1, 2]])).toThrow();
  });
});
