import { describe, expect, it } from 'vitest';
import { parseSheetCellValue, serializeSheetCell } from '../src';

describe('serializeSheetCell', () => {
  it('serializes arrays to json strings', () => {
    expect(serializeSheetCell(['a', 'b'])).toBe('["a","b"]');
  });
});

describe('parseSheetCellValue', () => {
  it('parses primitives and arrays', () => {
    expect(parseSheetCellValue('')).toBeNull();
    expect(parseSheetCellValue('42')).toBe(42);
    expect(parseSheetCellValue('true')).toBe(true);
    expect(parseSheetCellValue('["a","b"]')).toEqual(['a', 'b']);
    expect(parseSheetCellValue('Ada')).toBe('Ada');
  });
});
