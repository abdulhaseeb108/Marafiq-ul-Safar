// @vitest-environment node
/**
 * The Cloudflare Pages Function that forwards /api/* to the API host
 * (functions/api/[[path]].ts, docs/DEPLOY.md). It must pass the request on
 * unchanged, except that a visitor can never choose their own client IP or
 * pose as the proxy.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { onRequest } from '../../functions/api/[[path]]';

const API = 'https://api.example.test';
const SECRET = 's'.repeat(64);

function forwarded(): Request {
  const fetchMock = vi.mocked(globalThis.fetch);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [target, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
  // Node needs `duplex` to build a Request around a streamed body; Workers do not.
  return new Request(target, { ...init, duplex: 'half' } as RequestInit);
}

afterEach(() => vi.unstubAllGlobals());

describe('Pages Function /api proxy', () => {
  it('forwards path, query, method, body and cookies to the API host', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"ok":true}', { status: 201 })),
    );
    const response = await onRequest({
      request: new Request('https://site.example.test/api/v1/public/inquiries?x=1', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'msf_at=abc' },
        body: '{"a":1}',
      }),
      env: { API_ORIGIN: API, ORIGIN_PROXY_SECRET: SECRET },
    });
    expect(response.status).toBe(201);
    const sent = forwarded();
    expect(sent.url).toBe(`${API}/api/v1/public/inquiries?x=1`);
    expect(sent.method).toBe('POST');
    expect(sent.headers.get('cookie')).toBe('msf_at=abc');
    expect(await sent.text()).toBe('{"a":1}');
  });

  it("sets the client IP from Cloudflare and drops the visitor's own forwarding headers", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}')),
    );
    await onRequest({
      request: new Request('https://site.example.test/api/v1/public/config', {
        headers: {
          'CF-Connecting-IP': '203.0.113.7',
          'X-Forwarded-For': '1.2.3.4',
          'X-Real-IP': '1.2.3.4',
          Forwarded: 'for=1.2.3.4',
          'X-Origin-Secret': 'forged-by-visitor',
        },
      }),
      env: { API_ORIGIN: API, ORIGIN_PROXY_SECRET: SECRET },
    });
    const sent = forwarded();
    expect(sent.headers.get('x-forwarded-for')).toBe('203.0.113.7');
    expect(sent.headers.get('x-real-ip')).toBeNull();
    expect(sent.headers.get('forwarded')).toBeNull();
    expect(sent.headers.get('x-origin-secret')).toBe(SECRET);
  });

  it('never passes on a forged proxy secret when none is configured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}')),
    );
    await onRequest({
      request: new Request('https://site.example.test/api/v1/public/config', {
        headers: { 'X-Origin-Secret': 'forged-by-visitor' },
      }),
      env: { API_ORIGIN: API },
    });
    expect(forwarded().headers.get('x-origin-secret')).toBeNull();
  });

  it('does not follow redirects for the browser', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    await onRequest({
      request: new Request('https://site.example.test/api/v1/health'),
      env: { API_ORIGIN: API },
    });
    const init = vi.mocked(globalThis.fetch).mock.calls[0]?.[1] as RequestInit;
    expect(init.redirect).toBe('manual');
  });

  it('answers 503 in the standard error format when API_ORIGIN is missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await onRequest({
      request: new Request('https://site.example.test/api/v1/health'),
      env: { API_ORIGIN: '' },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: 'unavailable', message: 'Service unavailable' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
