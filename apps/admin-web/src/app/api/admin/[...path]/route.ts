import type { NextRequest } from 'next/server';
import { ACCESS_COOKIE } from '@/lib/session/constants';
import { csrfOk } from '@/lib/session/server';

const UPSTREAM = process.env.ADMIN_API_URL ?? 'http://localhost:8080/admin/v1';
const SAFE = new Set(['GET', 'HEAD']);

/**
 * Same-origin proxy for the console's browser calls to /admin/v1. The user's JWT lives in an
 * httpOnly cookie managed by Next (arch: admin-web) and core only accepts a Bearer header, so
 * the translation happens here. Unsafe methods need the double-submit CSRF token, as the
 * /api/auth/* handlers do.
 */
async function proxy(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  if (!SAFE.has(req.method) && !csrfOk(req)) {
    return Response.json({ error: 'csrf' }, { status: 403 });
  }
  const { path } = await params;
  const url = `${UPSTREAM}/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`;

  const headers = new Headers();
  const type = req.headers.get('content-type');
  if (type) headers.set('content-type', type);
  const token = req.cookies.get(ACCESS_COOKIE)?.value;
  if (token) headers.set('authorization', `Bearer ${token}`);

  const upstream = await fetch(url, {
    method: req.method,
    headers,
    body: SAFE.has(req.method) ? undefined : await req.arrayBuffer(),
    cache: 'no-store',
  });
  const out = new Headers();
  for (const name of ['content-type', 'retry-after']) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export { proxy as DELETE, proxy as GET, proxy as PATCH, proxy as POST, proxy as PUT };
