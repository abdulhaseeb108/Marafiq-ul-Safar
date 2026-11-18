/**
 * Cloudflare Pages Function: forwards every /api/* request to the API host
 * (docs/DEPLOY.md). The browser only ever talks to the site's own origin, so
 * cookies, the PDF preview frame and the content security policy all stay
 * same-origin, as in development (docs/05 decision 45).
 *
 * Pages settings (Settings -> Variables and Secrets):
 *   API_ORIGIN           https address of the API host, e.g. https://api-xyz.up.railway.app
 *   ORIGIN_PROXY_SECRET  the same value as the API's ORIGIN_PROXY_SECRET (a secret)
 */

interface Env {
  API_ORIGIN: string;
  ORIGIN_PROXY_SECRET?: string;
}

interface PagesContext {
  request: Request;
  env: Env;
}

/** Headers a caller could use to pose as the proxy or choose their own client IP. */
const DROPPED = ['x-forwarded-for', 'x-real-ip', 'forwarded', 'x-origin-secret', 'host'];

export async function onRequest({ request, env }: PagesContext): Promise<Response> {
  if (!env.API_ORIGIN) {
    return new Response(
      JSON.stringify({ error: { code: 'unavailable', message: 'Service unavailable' } }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    );
  }
  const incoming = new URL(request.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, env.API_ORIGIN);

  const headers = new Headers(request.headers);
  for (const name of DROPPED) headers.delete(name);
  // Cloudflare sets CF-Connecting-IP to the real visitor; the API's rate limits use it.
  const clientIp = request.headers.get('CF-Connecting-IP');
  if (clientIp) headers.set('X-Forwarded-For', clientIp);
  if (env.ORIGIN_PROXY_SECRET) headers.set('X-Origin-Secret', env.ORIGIN_PROXY_SECRET);

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  return fetch(target, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: 'manual',
  });
}
