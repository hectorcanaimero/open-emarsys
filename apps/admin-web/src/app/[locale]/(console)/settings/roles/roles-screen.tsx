'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { components } from '@oe/ts-contracts/openapi/identity';
import { createApiClient } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import {
  PERMISSION_ACTIONS,
  PERMISSION_MODULES,
  isDefaultRole,
  permissionKey,
  type PermissionAction,
  type PermissionModule,
} from './permission-catalog';

type Role = components['schemas']['Role'];
type Permission = components['schemas']['Permission'];

export function RolesScreen() {
  const t = useTranslations('settings.roles');
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
  const [draftPermissions, setDraftPermissions] = useState<Map<string, Permission>>(new Map());
  const [saving, setSaving] = useState(false);
  const [rowError, setRowError] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const client = createApiClient();
    const { data, response } = await client.GET('/roles', { params: { query: { limit: 200 } } });
    if (!response.ok || !data) {
      setLoadError(true);
      return;
    }
    setLoadError(false);
    setRoles(data.items);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function startEdit(role: Role) {
    setEditingRoleId(role.id);
    setDraftPermissions(
      new Map(role.permissions.map((p) => [permissionKey(p.module, p.action), p]))
    );
    setRowError((prev) => ({ ...prev, [role.id]: '' }));
  }

  function toggleCell(module: PermissionModule, action: PermissionAction) {
    const key = permissionKey(module, action);
    setDraftPermissions((prev) => {
      const next = new Map(prev);
      if (next.has(key)) next.delete(key);
      else next.set(key, { module, action });
      return next;
    });
  }

  async function saveRole(role: Role) {
    setSaving(true);
    const client = createApiClient();
    const { response } = await client.PATCH('/roles/{id}', {
      params: { path: { id: role.id } },
      body: { permissions: [...draftPermissions.values()] },
    });
    setSaving(false);
    if (!response.ok) {
      setRowError((prev) => ({ ...prev, [role.id]: t('errors.generic') }));
      return;
    }
    setEditingRoleId(null);
    void load();
  }

  async function deleteRole(role: Role) {
    if (isDefaultRole(role.name)) return;
    if (!window.confirm(t('deleteConfirm', { name: role.name }))) return;
    const client = createApiClient();
    const { response } = await client.DELETE('/roles/{id}', {
      params: { path: { id: role.id } },
    });
    if (!response.ok) {
      setRowError((prev) => ({ ...prev, [role.id]: t('errors.generic') }));
      return;
    }
    void load();
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold">{t('title')}</h1>

      {loadError ? (
        <p role="alert" className="mt-4 text-sm text-red-600">
          {t('loadError')}
        </p>
      ) : null}

      {roles ? (
        <ul className="mt-4 space-y-4">
          {roles.map((role) => {
            const isDefault = isDefaultRole(role.name);
            const isEditing = editingRoleId === role.id;
            return (
              <li key={role.id} className="rounded-md border border-border p-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <span className="font-medium">{role.name}</span>{' '}
                    <span className="text-sm text-muted-foreground">
                      ({role.permissions.length})
                    </span>
                    {isDefault ? (
                      <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">
                        {t('defaultBadge')}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-expanded={isEditing}
                      onClick={() => (isEditing ? setEditingRoleId(null) : startEdit(role))}
                    >
                      {t('editPermissions')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={isDefault}
                      title={isDefault ? t('defaultNotDeletable') : undefined}
                      aria-label={`${t('delete')} — ${role.name}`}
                      onClick={() => void deleteRole(role)}
                    >
                      {t('delete')}
                    </Button>
                  </div>
                </div>

                {rowError[role.id] ? (
                  <p role="alert" className="mt-2 text-sm text-red-600">
                    {rowError[role.id]}
                  </p>
                ) : null}

                {isEditing ? (
                  <div className="mt-4 overflow-x-auto">
                    <table className="text-sm">
                      <caption className="sr-only">
                        {t('matrixCaption', { name: role.name })}
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col" className="px-2 py-1 text-left">
                            <span className="sr-only">{t('table.module')}</span>
                          </th>
                          {PERMISSION_ACTIONS.map((action) => (
                            <th key={action} scope="col" className="px-2 py-1 text-center">
                              {t(`actions.${action}`)}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {PERMISSION_MODULES.map((module) => (
                          <tr key={module}>
                            <th scope="row" className="px-2 py-1 text-left font-normal">
                              {t(`modules.${module}`)}
                            </th>
                            {PERMISSION_ACTIONS.map((action) => (
                              <td key={action} className="px-2 py-1 text-center">
                                <input
                                  type="checkbox"
                                  aria-label={`${t(`modules.${module}`)} · ${t(`actions.${action}`)}`}
                                  checked={draftPermissions.has(permissionKey(module, action))}
                                  onChange={() => toggleCell(module, action)}
                                />
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="mt-3 flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        disabled={saving}
                        onClick={() => void saveRole(role)}
                      >
                        {saving ? t('saving') : t('savePermissions')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditingRoleId(null)}
                      >
                        {t('cancel')}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
