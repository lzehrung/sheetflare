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

  it('keeps nullable scalar columns typed as their scalar kind instead of collapsing them to json', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-26T13:00:00.000Z'));

    expect(
      inferTableSchema([
        'name',
        'score',
        'status'
      ], [
        {
          id: '1',
          rowNumber: 2,
          values: {
            name: 'Ada',
            score: 42,
            status: 'active'
          }
        },
        {
          id: '2',
          rowNumber: 3,
          values: {
            name: null,
            score: null,
            status: null
          }
        }
      ])
    ).toEqual({
      fields: [
        { name: 'name', inferredType: 'string', nullable: true },
        { name: 'score', inferredType: 'number', nullable: true },
        { name: 'status', inferredType: 'string', nullable: true }
      ],
      inferredAt: '2026-04-26T13:00:00.000Z'
    });

    vi.useRealTimers();
  });
});
