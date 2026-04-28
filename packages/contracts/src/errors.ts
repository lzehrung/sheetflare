import { ZodError } from 'zod';

export class AppError extends Error {
  readonly details?: unknown;

  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    details?: unknown
  ) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'NOT_FOUND', 404, details);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'FORBIDDEN', 403, details);
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'BAD_REQUEST', 400, details);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'CONFLICT', 409, details);
  }
}

export class BadGatewayError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'BAD_GATEWAY', 502, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized', details?: unknown) {
    super(message, 'UNAUTHORIZED', 401, details);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'TOO_MANY_REQUESTS', 429, details);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'SERVICE_UNAVAILABLE', 503, details);
  }
}

export class NotImplementedError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'NOT_IMPLEMENTED', 501, details);
  }
}

export function toErrorResponse(error: unknown) {
  if (error instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: {
          code: 'BAD_REQUEST',
          message: 'Request validation failed.',
          details: error.flatten()
        }
      }
    };
  }

  if (error instanceof AppError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          details: error.details ?? null
        }
      }
    };
  }

  const message = error instanceof Error ? error.message : 'Unexpected error';
  return {
    status: 500,
    body: {
      error: {
        code: 'INTERNAL_ERROR',
        message,
        details: null
      }
    }
  };
}
