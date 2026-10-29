type RpcResponse = { type: string; result: unknown };

function hasResponseType<TResponse extends RpcResponse, TType extends TResponse['type']>(
  response: TResponse,
  type: TType
): response is Extract<TResponse, { type: TType }> {
  return response.type === type;
}

export function expectRpcResult<TResponse extends RpcResponse, TType extends TResponse['type']>(
  response: TResponse,
  type: TType
): Extract<TResponse, { type: TType }>['result'] {
  if (!hasResponseType(response, type)) {
    throw new Error(`Expected a ${type} response but received ${response.type}.`);
  }

  return response.result;
}
