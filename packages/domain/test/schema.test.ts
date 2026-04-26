import { describe, expect, it, vi } from 'vitest';
import { inferTableSchema } from '../src';

describe('inferTableSchema', () => {
  it('infers stable field types', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-26T12:00:00.000Z'));

    expect(
      inferTableSchema([
        'active',
        'createdAt',
        'score',
        'tags',
        'notes'
      ], [
        {
          id: '1',
          rowNumber: 2,
          values: {
            active: true,
            createdAt: '2026-04-26T11:00:00.000Z',
            score: 42,
            tags: ['alpha', 'beta']
          }
        },
        {
          id: '2',
          rowNumber: 3,
          values: {
            active: false,
            createdAt: '2026-04-27T11:00:00.000Z',
            score: 41,
            tags: null
          }
        }
      ])
    ).toEqual({
      fields: [
        { name: 'active', inferredType: 'boolean', nullable: false },
        { name: 'createdAt', inferredType: 'datetime', nullable: false },
        { name: 'notes', inferredType: 'unknown', nullable: true },
        { name: 'score', inferredType: 'number', nullable: false },
        { name: 'tags', inferredType: 'json', nullable: true }
      ],
      inferredAt: '2026-04-26T12:00:00.000Z'
    });

    vi.useRealTimers();
  });
});
