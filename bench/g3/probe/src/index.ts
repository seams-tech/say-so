// G3 probe: calls the SaySo Worker of a lane through a service binding, as that lane's Gateway
// does, and measures the call. It adds no authorization: the SaySo Worker checks the
// `Authorization: Bearer SAYSO_API_KEY` header that the caller sends. Delete the probe after
// the run (`wrangler delete -c bench/g3/probe/wrangler.jsonc`).
interface Env {
  SAYSO: Fetcher;
}

const ROUTES = new Set(['GET /healthz', 'POST /v1/enroll', 'POST /v1/verify']);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!ROUTES.has(`${request.method} ${url.pathname}`)) {
      return new Response('not found', { status: 404 });
    }
    const body = request.method === 'POST' ? await request.arrayBuffer() : undefined;
    const headers = new Headers({ 'Content-Type': 'application/json' });
    const auth = request.headers.get('Authorization');
    if (auth) headers.set('Authorization', auth);
    // In a Worker the clock moves only across I/O, so this is the time of the binding call.
    const started = Date.now();
    const upstream = await env.SAYSO.fetch(`https://sayso.internal${url.pathname}`, {
      method: request.method,
      headers,
      body,
    });
    const text = await upstream.text();
    const bindingMs = Date.now() - started;
    return new Response(text, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json', 'X-SaySo-Binding-Ms': String(bindingMs) },
    });
  },
};
