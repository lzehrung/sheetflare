import { describe, expect, it } from 'vitest';
import { applyFieldRuleNormalization, normalizeFieldRules, validateFieldRules } from '../src';

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
});
