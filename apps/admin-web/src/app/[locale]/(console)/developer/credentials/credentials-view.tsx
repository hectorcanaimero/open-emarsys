'use client';

import type { components } from '@oe/ts-contracts/openapi/identity';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { createApiClient } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Dialog } from '../dialog';
import { AVAILABLE_SCOPES } from './scopes';

type ApiClientItem = components['schemas']['ApiClient'];

export function CredentialsView() {
  const t = useTranslations('developer.credentials');

  const [clients, setClients] = useState<ApiClientItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(false);

  const [newSecret, setNewSecret] = useState<{ clientId: string; clientSecret: string } | null>(
    null
  );
  const [copied, setCopied] = useState(false);

  const [revokeTarget, setRevokeTarget] = useState<ApiClientItem | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState(false);

  const loadClients = useCallback(async (cursor?: string) => {
    const { data, error } = await createApiClient().GET('/api-clients', {
      params: { query: cursor ? { cursor } : {} },
    });
    if (error) {
      setLoadError(true);
      return;
    }
    setLoadError(false);
    setClients((prev) => (cursor ? [...prev, ...data.items] : data.items));
    setNextCursor(data.next_cursor);
  }, []);

  useEffect(() => {
    loadClients();
  }, [loadClients]);

  function toggleScope(scope: string) {
    setScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]
    );
  }

  function closeCreateDialog() {
    setCreateOpen(false);
    setName('');
    setScopes([]);
    setCreateError(false);
  }

  async function submitCreate() {
    if (!name.trim() || scopes.length === 0) return;
    setCreating(true);
    setCreateError(false);
    const { data, error } = await createApiClient().POST('/api-clients', {
      body: { name: name.trim(), scopes: scopes as components['schemas']['PermissionString'][] },
    });
    setCreating(false);
    if (error) {
      setCreateError(true);
      return;
    }
    setClients((prev) => [data, ...prev]);
    setNewSecret({ clientId: data.client_id, clientSecret: data.client_secret });
    closeCreateDialog();
  }

  function closeSecretDialog() {
    setNewSecret(null);
    setCopied(false);
  }

  async function copySecret() {
    if (!newSecret) return;
    await navigator.clipboard.writeText(newSecret.clientSecret);
    setCopied(true);
  }

  async function confirmRevoke() {
    if (!revokeTarget) return;
    setRevoking(true);
    setRevokeError(false);
    const { data, error } = await createApiClient().POST('/api-clients/{id}/revoke', {
      params: { path: { id: revokeTarget.id } },
    });
    setRevoking(false);
    if (error) {
      setRevokeError(true);
      return;
    }
    setClients((prev) => prev.map((c) => (c.id === data.id ? data : c)));
    setRevokeTarget(null);
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>{t('newButton')}</Button>
      </div>

      {loadError && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {t('errors.loadFailed')}
        </p>
      )}

      <table className="mt-6 w-full text-left text-sm">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th className="py-2 font-medium">{t('table.name')}</th>
            <th className="py-2 font-medium">{t('table.clientId')}</th>
            <th className="py-2 font-medium">{t('table.scopes')}</th>
            <th className="py-2 font-medium">{t('table.status')}</th>
            <th className="py-2 font-medium">
              <span className="sr-only">{t('table.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {clients.length === 0 && !loadError && (
            <tr>
              <td colSpan={5} className="py-4 text-muted-foreground">
                {t('empty')}
              </td>
            </tr>
          )}
          {clients.map((client) => (
            <tr key={client.id} className="border-b border-border">
              <td className="py-2">{client.name}</td>
              <td className="py-2 font-mono text-xs">{client.client_id}</td>
              <td className="py-2 text-xs">{client.scopes.join(', ')}</td>
              <td className="py-2">
                {client.status === 'active' ? t('status.active') : t('status.revoked')}
              </td>
              <td className="py-2 text-right">
                {client.status === 'active' && (
                  <Button variant="ghost" size="sm" onClick={() => setRevokeTarget(client)}>
                    {t('revokeButton')}
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {nextCursor && (
        <Button
          variant="ghost"
          className="mt-4"
          onClick={() => loadClients(nextCursor)}
        >
          {t('loadMore')}
        </Button>
      )}

      <section className="mt-8 rounded-lg border border-border p-4">
        <h2 className="font-semibold">{t('curlExample.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('curlExample.description')}</p>
        <pre className="mt-3 overflow-x-auto rounded-md bg-muted p-3 text-xs">
          {`curl -X POST https://tu-dominio.example/api/v3/oauth/token \\
  -d grant_type=client_credentials \\
  -d client_id=<client_id> \\
  -d client_secret=<client_secret>`}
        </pre>
      </section>

      <Dialog open={createOpen} onClose={closeCreateDialog} titleId="create-client-title">
        <h2 id="create-client-title" className="text-lg font-semibold">
          {t('createDialog.title')}
        </h2>

        <label htmlFor="client-name" className="mt-4 block text-sm font-medium">
          {t('createDialog.nameLabel')}
        </label>
        <input
          id="client-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="mt-1 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
        />

        <fieldset className="mt-4">
          <legend className="text-sm font-medium">{t('createDialog.scopesLabel')}</legend>
          <div className="mt-2 space-y-2">
            {AVAILABLE_SCOPES.map((scope) => (
              <label key={scope} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={() => toggleScope(scope)}
                />
                {scope}
              </label>
            ))}
          </div>
        </fieldset>

        {createError && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {t('errors.createFailed')}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={closeCreateDialog}>
            {t('createDialog.cancel')}
          </Button>
          <Button
            onClick={submitCreate}
            disabled={creating || !name.trim() || scopes.length === 0}
          >
            {creating ? t('createDialog.creating') : t('createDialog.submit')}
          </Button>
        </div>
      </Dialog>

      <Dialog open={newSecret !== null} onClose={closeSecretDialog} titleId="secret-dialog-title">
        {newSecret && (
          <>
            <h2 id="secret-dialog-title" className="text-lg font-semibold">
              {t('secretDialog.title')}
            </h2>
            <p role="alert" className="mt-2 text-sm text-destructive">
              {t('secretDialog.warning')}
            </p>

            <p className="mt-4 text-sm font-medium">{t('secretDialog.clientIdLabel')}</p>
            <p className="font-mono text-xs">{newSecret.clientId}</p>

            <p className="mt-3 text-sm font-medium">{t('secretDialog.clientSecretLabel')}</p>
            <p className="font-mono text-xs">{newSecret.clientSecret}</p>

            <div className="mt-6 flex justify-end gap-2">
              <Button variant="ghost" onClick={copySecret}>
                {copied ? t('secretDialog.copied') : t('secretDialog.copy')}
              </Button>
              <Button onClick={closeSecretDialog}>{t('secretDialog.done')}</Button>
            </div>
          </>
        )}
      </Dialog>

      <Dialog
        open={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        titleId="revoke-dialog-title"
      >
        {revokeTarget && (
          <>
            <h2 id="revoke-dialog-title" className="text-lg font-semibold">
              {t('revokeDialog.title')}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t('revokeDialog.body', { name: revokeTarget.name })}
            </p>

            {revokeError && (
              <p role="alert" className="mt-3 text-sm text-destructive">
                {t('errors.revokeFailed')}
              </p>
            )}

            <div className="mt-6 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setRevokeTarget(null)}>
                {t('revokeDialog.cancel')}
              </Button>
              <Button onClick={confirmRevoke} disabled={revoking}>
                {revoking ? t('revokeDialog.revoking') : t('revokeDialog.confirm')}
              </Button>
            </div>
          </>
        )}
      </Dialog>
    </div>
  );
}
