import {
  AppError,
  BadGatewayError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnauthorizedError,
  toErrorResponse
} from '@sheetflare/contracts';
import { ZodError, type z } from 'zod';

export interface DurableRpcResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
}

export interface DurableRpcStubLike {
  fetch(input: unknown, init?: unknown): Promise<DurableRpcResponseLike>;
}

export class DurableRpcError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly responseText: string,
    name = 'DurableRpcError'
  ) {
    super(message);
    this.name = name;
  }
}

function createAppErrorFromBody(error: { code: string; message: string; details?: unknown }, status: number) {
  switch (error.code) {
    case 'BAD_GATEWAY':
      return new BadGatewayError(error.message, error.details);
    case 'BAD_REQUEST':
      return new BadRequestError(error.message, error.details);
    case 'CONFLICT':
      return new ConflictError(error.message, error.details);
    case 'FORBIDDEN':
      return new ForbiddenError(error.message, error.details);
    case 'NOT_FOUND':
      return new NotFoundError(error.message, error.details);
    case 'SERVICE_UNAVAILABLE':
      return new ServiceUnavailableError(error.message, error.details);
    case 'TOO_MANY_REQUESTS':
      return new TooManyRequestsError(error.message, error.details);
    case 'UNAUTHORIZED':
      return new UnauthorizedError(error.message, error.details);
    default:
      return new AppError(error.message, error.code, status, error.details);
  }
}

function parseDurableRpcError(responseText: string, status: number) {
  try {
    const parsed = JSON.parse(responseText) as {
      error?: {
        code?: string;
        message?: string;
        details?: unknown;
      };
    };

    if (
      parsed.error &&
      typeof parsed.error.code === 'string' &&
      typeof parsed.error.message === 'string'
    ) {
      return createAppErrorFromBody(
        {
          code: parsed.error.code,
          message: parsed.error.message,
          details: parsed.error.details
        },
        status
      );
    }
  } catch {
    return null;
  }

  return null;
}

export async function doRpc<TResponse>(
  stub: DurableRpcStubLike,
  body: unknown
): Promise<TResponse> {
  const response = await stub.fetch('https://do.internal/rpc', {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const responseText = await response.text();
    const parsedError = parseDurableRpcError(responseText, response.status);
    if (parsedError) {
      throw parsedError;
    }

    throw new DurableRpcError(
      `Durable Object RPC failed with ${response.status}.`,
      response.status,
      responseText
    );
  }

  return (await response.json()) as TResponse;
}

export async function parseDurableObjectRpcRequest<TRequest>(
  request: Request,
  schema: z.ZodType<TRequest>
): Promise<TRequest> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new BadRequestError('Malformed JSON in Durable Object RPC request.');
  }

  return schema.parse(body);
}

export function durableObjectErrorResponse(error: unknown): Response {
  if (!(error instanceof AppError) && !(error instanceof ZodError)) {
    console.error(
      JSON.stringify({
        event: 'durable_object.error',
        errorName: error instanceof Error ? error.name : 'UnknownError',
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack ?? null : null
      })
    );
  }

  const { status, body } = toErrorResponse(error);
  return Response.json(body, { status });
}
