import { describe, expect, it } from 'vitest';
import { applyFieldRuleNormalization, canonicalizeFieldValue, coerceRowFilter, normalizeFieldRules, validateFieldRules } from '../src';

describe('normalizeFieldRules', () => {
  it('trims field names and removes duplicate enum and normalize entries', () => {
    expect(normalizeFieldRules({
      ' email ': {
        enum: [' active ', 'active', 'pending'],
        normalize: ['trim', 'trim', 'lowercase']
      }
    })).toEqual({
      email: {
        enum: ['active', 'pending'],
        normalize: ['trim', 'lowercase']
      }
    });
  });
});

describe('applyFieldRuleNormalization', () => {
  it('applies trim and lowercase in order for string fields only', () => {
    expect(applyFieldRuleNormalization({
      email: '  Alice@Example.com  ',
      active: true
    }, {
      email: {
        normalize: ['trim', 'lowercase']
      }
    })).toEqual({
      email: 'alice@example.com',
      active: true
    });
  });
});

describe('canonicalizeFieldValue', () => {
  it('applies the write-time normalization before type coercion', () => {
    expect(canonicalizeFieldValue('  Alice@Example.com ', { normalize: ['trim', 'lowercase'] })).toBe('alice@example.com');
    expect(canonicalizeFieldValue(' 10 ', { type: 'number', normalize: ['trim'] })).toBe(10);
    expect(canonicalizeFieldValue('Ada', undefined)).toBe('Ada');
    expect(canonicalizeFieldValue(null, { normalize: ['trim'] })).toBeNull();
  });
});

describe('validateFieldRules', () => {
  it('rejects blank required values after normalization', () => {
    expect(validateFieldRules({
      email: '   '
    }, {
      email: {
        required: true,
        normalize: ['trim']
      }
    })).toEqual([
      {
        field: 'email',
        code: 'REQUIRED',
        message: 'email is required.'
      }
    ]);
  });

  it('accepts blank optional enum values but rejects out-of-set values', () => {
    expect(validateFieldRules({
      status: ''
    }, {
      status: {
        enum: ['pending', 'active']
      }
    })).toEqual([]);

    expect(validateFieldRules({
      status: 'disabled'
    }, {
      status: {
        enum: ['pending', 'active']
      }
    })).toEqual([
      {
        field: 'status',
        code: 'ENUM',
        message: 'status must be one of: pending, active.'
      }
    ]);
  });

  it('coerces canonical string scalars for explicit typed rules and still rejects invalid values', () => {
    expect(validateFieldRules({
      score: '10',
      active: 'true',
      dueDate: '05/01/2026',
      updatedAt: '2026-05-01'
    }, {
      score: {
        type: 'number'
      },
      active: {
        type: 'boolean'
      },
      dueDate: {
        type: 'date'
      },
      updatedAt: {
        type: 'datetime'
      }
    })).toEqual([
      {
        field: 'dueDate',
        code: 'TYPE',
        message: 'dueDate must be a date.'
      },
      {
        field: 'updatedAt',
        code: 'TYPE',
        message: 'updatedAt must be a datetime.'
      }
    ]);
  });

  it('rejects impossible calendar dates and datetime components', () => {
    const rules = {
      dueDate: { type: 'date' as const },
      updatedAt: { type: 'datetime' as const }
    };

    for (const dueDate of ['2026-02-30', '2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-00']) {
      expect(validateFieldRules({ dueDate }, rules)).toEqual([
        { field: 'dueDate', code: 'TYPE', message: 'dueDate must be a date.' }
      ]);
    }

    for (const updatedAt of ['2026-02-30T00:00:00.000Z', '2026-04-26T24:00:00Z', '2026-04-26T10:60:00Z', '2026-04-26T10:00:61Z', '2026-04-26T10:00:00+25:00', '2026-04-26Tnoon']) {
      expect(validateFieldRules({ updatedAt }, rules)).toEqual([
        { field: 'updatedAt', code: 'TYPE', message: 'updatedAt must be a datetime.' }
      ]);
    }

    expect(validateFieldRules({
      dueDate: '2024-02-29',
      updatedAt: '2024-02-29T23:59:59.999Z'
    }, rules)).toEqual([]);
    expect(validateFieldRules({
      dueDate: '2026-12-31',
      updatedAt: '2026-04-26T10:00:00+05:30'
    }, rules)).toEqual([]);
    expect(validateFieldRules({ updatedAt: '2026-04-26T10:00' }, rules)).toEqual([]);
  });
});

describe('coerceRowFilter', () => {
  it('coerces typed scalar filter values, canonicalizes rowNumber operands, and leaves string id operands untouched', () => {
    expect(coerceRowFilter({
      score: {
        eq: '10',
        in: ['10', '11', null]
      },
      active: {
        eq: 'true'
      },
      rowNumber: {
        gt: '10'
      },
      id: {
        eq: 'row-10'
      }
    }, {
      score: {
        type: 'number'
      },
      active: {
        type: 'boolean'
      }
    })).toEqual({
      score: {
        eq: 10,
        in: [10, 11, null]
      },
      active: {
        eq: true
      },
      rowNumber: {
        gt: 10
      },
      id: {
        eq: 'row-10'
      }
    });
  });

  it('canonicalizes numeric rowNumber operands and rejects operands that cannot match a row number', () => {
    expect(coerceRowFilter({
      rowNumber: { in: ['2', 3, null] }
    }, {})).toEqual({
      rowNumber: { in: [2, 3, null] }
    });
    expect(coerceRowFilter({
      rowNumber: { gte: '2', lt: 5 }
    }, {})).toEqual({
      rowNumber: { gte: 2, lt: 5 }
    });

    for (const definition of [{ eq: 'two' }, { eq: '02' }, { eq: true }, { neq: '' }, { in: [2, 'x'] }, { gt: 'abc' }]) {
      expect(() => coerceRowFilter({ rowNumber: definition }, {})).toThrow('rowNumber filters require numeric values.');
    }

    for (const definition of [{ contains: '2' }, { startsWith: '1' }]) {
      expect(() => coerceRowFilter({ rowNumber: definition }, {})).toThrow('rowNumber filters do not support startsWith or contains.');
    }
  });

  it('canonicalizes numeric and boolean id operands to the id strings they denote', () => {
    expect(coerceRowFilter({ id: { eq: 5 } }, {})).toEqual({ id: { eq: '5' } });
    expect(coerceRowFilter({ id: { neq: false } }, {})).toEqual({ id: { neq: 'false' } });
    expect(coerceRowFilter({ id: { in: [5, '6', true, null] } }, {})).toEqual({ id: { in: ['5', '6', 'true', null] } });
    expect(coerceRowFilter({ id: { gte: 10.5, lt: '20' } }, {})).toEqual({ id: { gte: '10.5', lt: '20' } });
    expect(coerceRowFilter({ id: { eq: null } }, {})).toEqual({ id: { eq: null } });
    expect(coerceRowFilter({ id: { isNull: false } }, {})).toEqual({ id: { isNull: false } });
    expect(coerceRowFilter({ id: { startsWith: 'row-' } }, {})).toEqual({ id: { startsWith: 'row-' } });
    expect(coerceRowFilter({ id: { contains: '5' } }, {})).toEqual({ id: { contains: '5' } });
  });

  it('normalizes operands for normalized fields, folding only case for pattern operators', () => {
    expect(coerceRowFilter({
      email: { eq: ' ALICE@example.com ' },
      name: { startsWith: ' Al' },
      tag: { in: [' X ', null] }
    }, {
      email: { normalize: ['trim', 'lowercase'] },
      name: { normalize: ['trim', 'lowercase'] },
      tag: { normalize: ['trim'] }
    })).toEqual({
      email: { eq: 'alice@example.com' },
      name: { startsWith: ' al' },
      tag: { in: ['X', null] }
    });
  });
});
