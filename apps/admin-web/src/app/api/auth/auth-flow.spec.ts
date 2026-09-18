// @vitest-environment node
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { middleware } from '@/middleware';
import { POST as login } from './login/route';
import { POST as logout } from './logout/route';
import { POST as mfa } from './mfa/route';
import { GET as refresh } from './refresh/route';

const CORE = 'http://localhost:8080/admin/v1';
const APP = 'http://admin.test';

function jwt(expInSeconds: number) {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expInSeconds }));
  return `h.${payload.replace(/=+$/, '')}.s`;
}
const tokens = (n: number) => ({
  mfa_required: false,
  access_token: `access-${n}`,
  refresh_token: `refresh-${n}`,
  token_type: 'Bearer',
  expires_in: 900,
});
const problem = (status: number, headers?: Record<string, string>) =>
  HttpResponse.json({ type: 'about:blank', title: 'error', status }, { status, headers });

const server = setupServer(
  http.post(`${CORE}/auth/login`, async ({ request }) => {
    const { email, password } = (await request.json()) as { email: string; password: string };
    if (email === 'locked@x.co') return problem(423, { 'retry-after': '600' });
    if (password !== 'right-password') return problem(401);
    if (email === 'mfa@x.co') return HttpResponse.json({ mfa_required: true, mfa_token: 'mfa-1' });
    return HttpResponse.json(tokens(1));
  }),
  http.post(`${CORE}/auth/mfa/verify`, async ({ request }) => {
    const { mfa_token, code } = (await request.json()) as { mfa_token: string; code: string };
    return mfa_token === 'mfa-1' && code === '123456' ? HttpResponse.json(tokens(2)) : problem(401);
  }),
  http.post(`${CORE}/auth/refresh`, async ({ request }) => {
    const { refresh_token } = (await request.json()) as { refresh_token: string };
    return refresh_token === 'refresh-1' ? HttpResponse.json(tokens(3)) : problem(401);
  }),
  http.post(`${CORE}/auth/logout`, () => new HttpResponse(null, { status: 204 }))
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function post(path: string, body: unknown, { cookie = '', origin = APP, csrf = 'tok' } = {}) {
  return new NextRequest(`${APP}${path}`, {
    method: 'POST',
    headers: {
      host: 'admin.test',
      origin,
      'x-csrf-token': csrf,
      cookie: `oe_csrf=tok; ${cookie}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function get(path: string, cookie = '') {
  return new NextRequest(`${APP}${path}`, { headers: { cookie } });
}

/** `name` → the raw `Set-Cookie` line, for asserting its attributes. */
function setCookies(res: Response) {
  return Object.fromEntries(res.headers.getSetCookie().map((c) => [c.split('=')[0], c]));
}

describe('login', () => {
  it('without MFA sets httpOnly session cookies and returns next', async () => {
    const res = await login(
      post('/api/auth/login', { email: 'a@x.co', password: 'right-password', next: '/es/campaigns', locale: 'es' })
    );
    expect(await res.json()).toEqual({ next: '/es/campaigns' });

    const cookies = setCookies(res);
    expect(cookies.oe_at).toMatch(/^oe_at=access-1;/);
    expect(cookies.oe_at).toMatch(/Path=\/;/);
    expect(cookies.oe_rt).toMatch(/^oe_rt=refresh-1;/);
    expect(cookies.oe_rt).toMatch(/Path=\/api\/auth;/);
    for (const name of ['oe_at', 'oe_rt']) {
      expect(cookies[name]).toMatch(/HttpOnly/);
      expect(cookies[name]).toMatch(/Secure/);
      expect(cookies[name]).toMatch(/SameSite=lax/i);
    }
  });

  it('with MFA keeps the challenge in an httpOnly cookie until the code is verified', async () => {
    const first = await login(post('/api/auth/login', { email: 'mfa@x.co', password: 'right-password', locale: 'pt' }));
    expect(await first.json()).toEqual({ mfa: true });
    const challenge = setCookies(first);
    expect(challenge.oe_at).toBeUndefined();
    expect(challenge.oe_mfa).toMatch(/HttpOnly/);
    expect(challenge.oe_mfa).toMatch(/Path=\/api\/auth\/mfa;/);

    const wrong = await mfa(post('/api/auth/mfa', { code: '000000', locale: 'pt' }, { cookie: 'oe_mfa=mfa-1' }));
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: 'invalid' });

    const res = await mfa(post('/api/auth/mfa', { code: '123456', locale: 'pt' }, { cookie: 'oe_mfa=mfa-1' }));
    expect(await res.json()).toEqual({ next: '/pt' });
    const cookies = setCookies(res);
    expect(cookies.oe_at).toMatch(/^oe_at=access-2;.*HttpOnly/);
    expect(cookies.oe_rt).toMatch(/^oe_rt=refresh-2;.*HttpOnly/);
    expect(cookies.oe_mfa).toMatch(/Max-Age=0/);
  });

  it('answers the same for an unknown email and a wrong password', async () => {
    const unknown = await login(post('/api/auth/login', { email: 'nobody@x.co', password: 'nope' }));
    const wrong = await login(post('/api/auth/login', { email: 'a@x.co', password: 'nope' }));
    expect([unknown.status, await unknown.json()]).toEqual([401, { error: 'invalid' }]);
    expect([wrong.status, await wrong.json()]).toEqual([401, { error: 'invalid' }]);
  });

  it('reports a locked account with its retry delay', async () => {
    const res = await login(post('/api/auth/login', { email: 'locked@x.co', password: 'x' }));
    expect([res.status, await res.json()]).toEqual([423, { error: 'locked', retryAfter: 600 }]);
  });

  it('rejects an absolute next and falls back to the locale home', async () => {
    const res = await login(
      post('/api/auth/login', { email: 'a@x.co', password: 'right-password', next: 'https://evil.com', locale: 'en' })
    );
    expect(await res.json()).toEqual({ next: '/en' });
  });

  it('rejects writes without the CSRF token or from another origin', async () => {
    const body = { email: 'a@x.co', password: 'right-password' };
    expect((await login(post('/api/auth/login', body, { csrf: 'other' }))).status).toBe(403);
    expect((await login(post('/api/auth/login', body, { origin: 'https://evil.com' }))).status).toBe(403);
    expect((await logout(post('/api/auth/logout', {}, { csrf: '' }))).status).toBe(403);
  });
});

describe('refresh and logout', () => {
  it('rotates the token pair and returns to next', async () => {
    const res = await refresh(get('/api/auth/refresh?next=%2Fes%2Fcampaigns', 'oe_rt=refresh-1'));
    expect(res.headers.get('location')).toBe(`${APP}/es/campaigns`);
    expect(setCookies(res).oe_at).toMatch(/^oe_at=access-3;.*HttpOnly/);
  });

  it('sends a rejected session to login and never to an external next', async () => {
    const res = await refresh(get('/api/auth/refresh?next=https%3A%2F%2Fevil.com', 'oe_rt=stale'));
    expect(res.headers.get('location')).toBe(`${APP}/es/login?next=%2F`);
    expect(setCookies(res).oe_at).toMatch(/Max-Age=0/);
  });

  it('clears the session on logout', async () => {
    const res = await logout(post('/api/auth/logout', { locale: 'en' }, { cookie: 'oe_rt=refresh-1; oe_at=a' }));
    expect(await res.json()).toEqual({ next: '/en/login' });
    expect(setCookies(res).oe_rt).toMatch(/Max-Age=0/);
  });
});

describe('middleware', () => {
  it('redirects (console) pages without a session to login with next', () => {
    const res = middleware(get('/es/profile/security?tab=mfa'));
    expect(res.headers.get('location')).toBe(
      `${APP}/es/login?next=%2Fes%2Fprofile%2Fsecurity%3Ftab%3Dmfa`
    );
  });

  it('lets auth pages through and issues the CSRF cookie', () => {
    const res = middleware(get('/pt/login'));
    expect(res.headers.get('location')).toBeNull();
    expect(setCookies(res).oe_csrf).toMatch(/^oe_csrf=[0-9a-f-]{36};/);
  });

  it('refreshes an expired access token', () => {
    const res = middleware(get('/en/profile/security', `oe_at=${jwt(-10)}`));
    expect(res.headers.get('location')).toBe(`${APP}/api/auth/refresh?next=%2Fen%2Fprofile%2Fsecurity`);
  });

  it('serves (console) pages with a valid access token', () => {
    const res = middleware(get('/en/profile/security', `oe_at=${jwt(600)}`));
    expect(res.headers.get('location')).toBeNull();
  });
});
