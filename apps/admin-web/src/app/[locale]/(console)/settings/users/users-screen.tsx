'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import type { components } from '@oe/ts-contracts/openapi/identity';
import { createApiClient } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { classifyUserError } from '../lib/backend-error';

type User = components['schemas']['User'];
type Role = components['schemas']['Role'];

export function UsersScreen() {
  const t = useTranslations('settings.users');
  const [users, setUsers] = useState<User[] | null>(null);
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState('');

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRoleIds, setInviteRoleIds] = useState<string[]>([]);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);
  const [inviteSubmitting, setInviteSubmitting] = useState(false);

  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editingRoleIds, setEditingRoleIds] = useState<string[]>([]);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    const client = createApiClient();
    const [usersRes, rolesRes] = await Promise.all([
      client.GET('/users', { params: { query: { limit: 200 } } }),
      client.GET('/roles', { params: { query: { limit: 200 } } }),
    ]);
    if (!usersRes.response.ok || !rolesRes.response.ok) {
      setLoadError(true);
      return;
    }
    setLoadError(false);
    setUsers(usersRes.data?.items ?? []);
    setRoles(rolesRes.data?.items ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const roleNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const role of roles ?? []) map.set(role.id, role.name);
    return map;
  }, [roles]);

  const filteredUsers = useMemo(() => {
    if (!users) return [];
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (user) =>
        user.email.toLowerCase().includes(q) || (user.name ?? '').toLowerCase().includes(q)
    );
  }, [users, search]);

  function toggleInviteRole(roleId: string) {
    setInviteRoleIds((prev) =>
      prev.includes(roleId) ? prev.filter((id) => id !== roleId) : [...prev, roleId]
    );
  }

  async function handleInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inviteRoleIds.length === 0) {
      setInviteError(t('invite.rolesRequired'));
      return;
    }
    setInviteSubmitting(true);
    setInviteError(null);
    setInviteSuccess(null);
    const client = createApiClient();
    const { data, response } = await client.POST('/users/invitations', {
      body: { email: inviteEmail, role_ids: inviteRoleIds },
    });
    setInviteSubmitting(false);
    if (!response.ok || !data) {
      setInviteError(t(`errors.${classifyUserError('invite', response.status)}`));
      return;
    }
    setInviteSuccess(t('invite.success', { email: data.email }));
    setInviteEmail('');
    setInviteRoleIds([]);
    void load();
  }

  function startEditRoles(user: User) {
    setEditingUserId(user.id);
    setEditingRoleIds(user.role_ids);
    setRowError((prev) => ({ ...prev, [user.id]: '' }));
  }

  function toggleEditingRole(roleId: string) {
    setEditingRoleIds((prev) =>
      prev.includes(roleId) ? prev.filter((id) => id !== roleId) : [...prev, roleId]
    );
  }

  async function saveRoles(user: User) {
    setRowBusy((prev) => ({ ...prev, [user.id]: true }));
    const client = createApiClient();
    const { response } = await client.PATCH('/users/{id}', {
      params: { path: { id: user.id } },
      body: { role_ids: editingRoleIds },
    });
    setRowBusy((prev) => ({ ...prev, [user.id]: false }));
    if (!response.ok) {
      setRowError((prev) => ({
        ...prev,
        [user.id]: t(`errors.${classifyUserError('updateRoles', response.status)}`),
      }));
      return;
    }
    setEditingUserId(null);
    void load();
  }

  async function toggleStatus(user: User) {
    const nextStatus = user.status === 'disabled' ? 'active' : 'disabled';
    const confirmed = window.confirm(
      nextStatus === 'disabled'
        ? t('deactivateConfirm', { email: user.email })
        : t('reactivateConfirm', { email: user.email })
    );
    if (!confirmed) return;
    setRowBusy((prev) => ({ ...prev, [user.id]: true }));
    const client = createApiClient();
    const { response } = await client.PATCH('/users/{id}', {
      params: { path: { id: user.id } },
      body: { status: nextStatus },
    });
    setRowBusy((prev) => ({ ...prev, [user.id]: false }));
    if (!response.ok) {
      setRowError((prev) => ({
        ...prev,
        [user.id]: t(`errors.${classifyUserError('updateStatus', response.status)}`),
      }));
      return;
    }
    void load();
  }

  async function deleteUser(user: User) {
    const confirmed = window.confirm(t('deleteConfirm', { email: user.email }));
    if (!confirmed) return;
    setRowBusy((prev) => ({ ...prev, [user.id]: true }));
    const client = createApiClient();
    const { response } = await client.DELETE('/users/{id}', {
      params: { path: { id: user.id } },
    });
    setRowBusy((prev) => ({ ...prev, [user.id]: false }));
    if (!response.ok) {
      setRowError((prev) => ({
        ...prev,
        [user.id]: t(`errors.${classifyUserError('delete', response.status)}`),
      }));
      return;
    }
    void load();
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold">{t('title')}</h1>

      <section aria-labelledby="invite-heading" className="mt-6 max-w-md">
        <h2 id="invite-heading" className="text-lg font-medium">
          {t('invite.heading')}
        </h2>
        <form className="mt-3 space-y-3" onSubmit={handleInvite}>
          <div>
            <label htmlFor="invite-email" className="block text-sm font-medium">
              {t('invite.emailLabel')}
            </label>
            <input
              id="invite-email"
              type="email"
              required
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              className="mt-1 block w-full rounded-md border border-border px-3 py-2 text-sm"
            />
          </div>
          <fieldset>
            <legend className="text-sm font-medium">{t('invite.rolesLabel')}</legend>
            <div className="mt-1 space-y-1">
              {(roles ?? []).map((role) => (
                <label key={role.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={inviteRoleIds.includes(role.id)}
                    onChange={() => toggleInviteRole(role.id)}
                  />
                  {role.name}
                </label>
              ))}
            </div>
          </fieldset>
          {inviteError ? (
            <p role="alert" className="text-sm text-red-600">
              {inviteError}
            </p>
          ) : null}
          {inviteSuccess ? (
            <p role="status" className="text-sm text-green-700">
              {inviteSuccess}
            </p>
          ) : null}
          <Button type="submit" disabled={inviteSubmitting}>
            {inviteSubmitting ? t('invite.submitting') : t('invite.submit')}
          </Button>
        </form>
      </section>

      <div className="mt-8 max-w-xs">
        <label htmlFor="user-search" className="block text-sm font-medium">
          {t('searchLabel')}
        </label>
        <input
          id="user-search"
          type="search"
          placeholder={t('searchPlaceholder')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="mt-1 block w-full rounded-md border border-border px-3 py-2 text-sm"
        />
      </div>

      {loadError ? (
        <p role="alert" className="mt-4 text-sm text-red-600">
          {t('loadError')}
        </p>
      ) : null}

      {users && filteredUsers.length === 0 && !loadError ? (
        <p className="mt-4 text-sm text-muted-foreground">{t('empty')}</p>
      ) : null}

      {users && filteredUsers.length > 0 ? (
        <table className="mt-4 w-full text-left text-sm">
          <caption className="sr-only">{t('title')}</caption>
          <thead>
            <tr>
              <th scope="col" className="border-b border-border px-2 py-2">
                {t('table.email')}
              </th>
              <th scope="col" className="border-b border-border px-2 py-2">
                {t('table.name')}
              </th>
              <th scope="col" className="border-b border-border px-2 py-2">
                {t('table.status')}
              </th>
              <th scope="col" className="border-b border-border px-2 py-2">
                {t('table.roles')}
              </th>
              <th scope="col" className="border-b border-border px-2 py-2">
                {t('table.actions')}
              </th>
            </tr>
          </thead>
          <tbody>
            {filteredUsers.map((user) => (
              <tr key={user.id}>
                <td className="border-b border-border px-2 py-2">{user.email}</td>
                <td className="border-b border-border px-2 py-2">{user.name ?? '—'}</td>
                <td className="border-b border-border px-2 py-2">{t(`status.${user.status}`)}</td>
                <td className="border-b border-border px-2 py-2">
                  {editingUserId === user.id ? (
                    <fieldset>
                      <legend className="sr-only">
                        {t('invite.rolesLabel')} — {user.email}
                      </legend>
                      {(roles ?? []).map((role) => (
                        <label key={role.id} className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={editingRoleIds.includes(role.id)}
                            onChange={() => toggleEditingRole(role.id)}
                          />
                          {role.name}
                        </label>
                      ))}
                      <div className="mt-2 flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          disabled={rowBusy[user.id]}
                          onClick={() => void saveRoles(user)}
                        >
                          {t('saveRoles')}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditingUserId(null)}
                        >
                          {t('cancel')}
                        </Button>
                      </div>
                    </fieldset>
                  ) : (
                    user.role_ids.map((id) => roleNameById.get(id) ?? id).join(', ')
                  )}
                </td>
                <td className="border-b border-border px-2 py-2">
                  <div className="flex flex-wrap gap-2">
                    {editingUserId !== user.id ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => startEditRoles(user)}
                        aria-label={`${t('editRoles')} — ${user.email}`}
                      >
                        {t('editRoles')}
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={rowBusy[user.id]}
                      onClick={() => void toggleStatus(user)}
                      aria-label={`${
                        user.status === 'disabled' ? t('reactivate') : t('deactivate')
                      } — ${user.email}`}
                    >
                      {user.status === 'disabled' ? t('reactivate') : t('deactivate')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={rowBusy[user.id]}
                      onClick={() => void deleteUser(user)}
                      aria-label={`${t('delete')} — ${user.email}`}
                    >
                      {t('delete')}
                    </Button>
                  </div>
                  {rowError[user.id] ? (
                    <p role="alert" className="mt-1 text-sm text-red-600">
                      {rowError[user.id]}
                    </p>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
