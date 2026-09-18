import 'reflect-metadata';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  type JWK,
  type KeyLike,
  SignJWT,
} from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AuthModule,
  CurrentPrincipal,
  InternalOnly,
  LocalKeyVerifier,
  type Principal,
  Public,
  RequirePermission,
  ServiceTokenClient,
} from './index.js';

const ISSUER = 'https://core.test';
const TENANT = '0191e4a2-1111-7000-8000-000000000001';

type Key = { kid: string; privateKey: KeyLike; jwk: JWK };

async function makeKey(kid: string): Promise<Key> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  return { kid, privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' } };
}

function sign(key: Key, claims: Record<string, unknown>, expOffset = 900): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ tenant_id: TENANT, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: key.kid, typ: 'JWT' })
    .setIssuer(ISSUER)
    .setIssuedAt(now - 10)
    .setExpirationTime(now + expOffset)
    .sign(key.privateKey);
}

const user = (perms: string[]) => ({ sub: 'u1', typ: 'user', perms });
const client = (scopes: string[]) => ({ sub: 'c1', typ: 'client', scopes });
const service = { sub: 'dispatcher', typ: 'service', tenant_id: null, scopes: [] };

@Controller()
class TestController {
  @Get('public')
  @Public()
  open() {
    return { ok: true };
  }

  @Get('campaigns')
  @RequirePermission('campaigns:view')
  campaigns(@CurrentPrincipal() p: Principal) {
    return { sub: p.sub };
  }

  @Get('internal')
  @InternalOnly()
  internal(@CurrentPrincipal() p: Principal) {
    return { sub: p.sub };
  }
}

describe('AuthModule with remote JWKS', () => {
  let jwks: JSONWebKeySet;
  let jwksServer: Server;
  let app: NestExpressApplication;
  let k1: Key;
  let k2: Key;

  beforeAll(async () => {
    [k1, k2] = await Promise.all([makeKey('k1'), makeKey('k2')]);
    jwks = { keys: [k1.jwk] };
    jwksServer = createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(jwks));
    });
    await new Promise<void>((r) => jwksServer.listen(0, '127.0.0.1', r));
    const { port } = jwksServer.address() as AddressInfo;

    @Module({
      imports: [
        AuthModule.forRoot({
          jwksUrl: `http://127.0.0.1:${port}/.well-known/jwks.json`,
          issuer: ISSUER,
          cooldownMs: 0,
        }),
      ],
      controllers: [TestController],
    })
    class TestAppModule {}

    app = await NestFactory.create<NestExpressApplication>(TestAppModule, { logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    jwksServer?.close();
  });

  const get = (path: string, token?: string) => {
    const r = request(app.getHttpServer()).get(path);
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  };

  it('accepts a valid user token with the permission', async () => {
    const res = await get('/campaigns', await sign(k1, user(['campaigns:view'])));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sub: 'u1' });
  });

  it('rejects a missing token with 401', async () => {
    expect((await get('/campaigns')).status).toBe(401);
  });

  it('rejects an expired token with 401', async () => {
    const token = await sign(k1, user(['campaigns:view']), -120);
    expect((await get('/campaigns', token)).status).toBe(401);
  });

  it('rejects a token signed by an unknown key with 401', async () => {
    const rogue = await makeKey('k1');
    expect((await get('/campaigns', await sign(rogue, user(['campaigns:view'])))).status).toBe(401);
  });

  it('rejects claims that break JwtClaims with 401', async () => {
    const token = await sign(k1, { sub: 'u1', typ: 'user', scopes: ['campaigns:view'] });
    expect((await get('/campaigns', token)).status).toBe(401);
  });

  it('picks up a rotated kid by refetching the JWKS', async () => {
    expect((await get('/campaigns', await sign(k1, user(['campaigns:view'])))).status).toBe(200);
    jwks = { keys: [k1.jwk, k2.jwk] };
    expect((await get('/campaigns', await sign(k2, user(['campaigns:view'])))).status).toBe(200);
  });

  it('returns 403 without the required permission', async () => {
    const token = await sign(k1, user(['contacts:view']));
    expect((await get('/campaigns', token)).status).toBe(403);
  });

  it('accepts a client whose scopes include the permission', async () => {
    const res = await get('/campaigns', await sign(k1, client(['campaigns:view'])));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sub: 'c1' });
  });

  it('returns 403 for a user on an @InternalOnly route', async () => {
    const token = await sign(k1, user(['campaigns:view']));
    expect((await get('/internal', token)).status).toBe(403);
  });

  it('accepts a service token on @InternalOnly and rejects it elsewhere', async () => {
    const token = await sign(k1, service);
    expect((await get('/internal', token)).status).toBe(200);
    expect((await get('/campaigns', token)).status).toBe(403);
  });

  it('serves @Public routes without a token', async () => {
    expect((await get('/public')).status).toBe(200);
  });
});

describe('LocalKeyVerifier', () => {
  it('verifies with in-memory keys and follows setKeys rotation', async () => {
    const [a, b] = await Promise.all([makeKey('a'), makeKey('b')]);
    const verifier = new LocalKeyVerifier({ keys: [a.jwk] }, ISSUER);
    expect((await verifier.verify(await sign(a, user([])))).sub).toBe('u1');
    await expect(verifier.verify(await sign(b, user([])))).rejects.toThrow();
    verifier.setKeys({ keys: [b.jwk] });
    expect((await verifier.verify(await sign(b, user([])))).sub).toBe('u1');
  });
});

describe('ServiceTokenClient', () => {
  it('caches the token and renews it near expiry', async () => {
    let calls = 0;
    let expiresIn = 900;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        calls++;
        expect(req.url).toBe('/internal/v1/service-token');
        expect(JSON.parse(body)).toEqual({ client_id: 'svc', client_secret: 's3cret' });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ access_token: `t${calls}`, expires_in: expiresIn }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    const c = new ServiceTokenClient({
      coreUrl: `http://127.0.0.1:${port}`,
      clientId: 'svc',
      clientSecret: 's3cret',
    });

    expect(await Promise.all([c.getToken(), c.getToken()])).toEqual(['t1', 't1']);
    expect(await c.authorization()).toBe('Bearer t1');
    expect(calls).toBe(1);

    expiresIn = 30; // inside the 60 s refresh skew: every call renews
    c['token'] = undefined;
    expect(await c.getToken()).toBe('t2');
    expect(await c.getToken()).toBe('t3');
    server.close();
  });
});
