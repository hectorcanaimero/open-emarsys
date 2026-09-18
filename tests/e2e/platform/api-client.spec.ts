import { expect, test } from '@playwright/test';
import { admin, BASE, demoAdmin, http, tokenFor, unique } from './helpers';

// FR-4: API client credentials.
test('5. create an API client, get a token, use it, revoke it and see it rejected', async () => {
  const demo = demoAdmin();
  const adminToken = await tokenFor(demo.email, demo.password);

  const created = await admin('POST', '/api-clients', adminToken, { name: unique('e2e client'), scopes: ['api_clients:view'] });
  expect(created.status).toBe(201);
  const { id, client_id, client_secret } = created.body;
  expect(client_secret).toBeTruthy();

  const tokenRequest = () =>
    http('POST', `${BASE}/api/v3/oauth/token`, {
      form: { grant_type: 'client_credentials', client_id, client_secret },
    });
  const issued = await tokenRequest();
  expect(issued.status).toBe(200);
  expect(issued.body.token_type).toBe('Bearer');
  const token: string = issued.body.access_token;

  // The token carries the client's scope: it can list API clients...
  const used = await admin('GET', '/api-clients', token);
  expect(used.status).toBe(200);
  // ...and nothing beyond it.
  expect((await admin('GET', '/users', token)).status).toBe(403);

  const revoked = await admin('POST', `/api-clients/${id}/revoke`, adminToken);
  expect(revoked.status).toBe(200);
  expect(revoked.body.status).toBe('revoked');

  expect((await admin('GET', '/api-clients', token)).status).toBe(401);
  expect((await tokenRequest()).status).toBe(401);
});
