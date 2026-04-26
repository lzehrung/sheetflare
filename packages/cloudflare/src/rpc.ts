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
    public readonly responseText: string
  ) {
    super(message);
  }
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
    throw new DurableRpcError(
      `Durable Object RPC failed with ${response.status}.`,
      response.status,
      responseText
    );
  }

  return (await response.json()) as TResponse;
}
