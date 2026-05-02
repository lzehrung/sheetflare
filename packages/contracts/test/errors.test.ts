import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { BadRequestError, toErrorResponse } from '../src';

describe('toErrorResponse', () => {
  it('preserves explicit AppError messages and details', () => {
    expect(toErrorResponse(new BadRequestError('Field is not indexed.', { field: 'email' }))).toEqual({
      status: 400,
      body: {
        error: {
          code: 'BAD_REQUEST',
          message: 'Field is not indexed.',
          details: {
            field: 'email'
          }
        }
      }
    });
  });

  it('preserves validation details without exposing internal exception text', () => {
    const result = z.object({ limit: z.number() }).safeParse({ limit: '100' });
    expect(result.success).toBe(false);

    if (result.success) {
      throw new Error('Expected validation to fail.');
    }

    const response = toErrorResponse(result.error);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('BAD_REQUEST');
    expect(response.body.error.message).toBe('Request validation failed.');
    expect(response.body.error.details).toBeTruthy();
  });

  it('uses a generic message for unexpected Error instances', () => {
    expect(toErrorResponse(new Error('postgres password leaked in stack'))).toEqual({
      status: 500,
      body: {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error.',
          details: null
        }
      }
    });
  });

  it('uses a generic message for unexpected non-Error throws', () => {
    expect(toErrorResponse('raw internal failure')).toEqual({
      status: 500,
      body: {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error.',
          details: null
        }
      }
    });
  });
});
