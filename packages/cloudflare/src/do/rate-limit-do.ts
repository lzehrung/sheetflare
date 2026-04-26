export class RateLimitDO {
  constructor(ctx: DurableObjectState, env: unknown) {
    void ctx;
    void env;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    return Response.json({ ok: true });
  }
}
