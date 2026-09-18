'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { AlertTriangle, Inbox, Loader2, Plus } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { Toaster, toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { createTenant, listTenants, TenantApiError, updateTenant } from './api';
import { Dialog } from './dialog';
import type { Tenant, TenantFormValues } from './schema';
import { toTenantPayload } from './schema';
import { TenantForm } from './tenant-form';

type DialogState =
  | { type: 'closed' }
  | { type: 'create' }
  | { type: 'edit'; tenant: Tenant }
  | { type: 'confirm-status'; tenant: Tenant; nextStatus: 'active' | 'suspended' };

export function TenantsClient() {
  const t = useTranslations('platform');
  const format = useFormatter();
  const titleId = useId();

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [dialog, setDialog] = useState<DialogState>({ type: 'closed' });
  const [submitting, setSubmitting] = useState(false);

  const loadFirstPage = useCallback(() => {
    setLoading(true);
    setError(false);
    listTenants()
      .then((page) => {
        setTenants(page.items);
        setNextCursor(page.next_cursor);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadFirstPage();
  }, [loadFirstPage]);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await listTenants(nextCursor);
      setTenants((prev) => [...prev, ...page.items]);
      setNextCursor(page.next_cursor);
    } catch {
      toast.error(t('errors.loadMoreFailed'));
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleCreate(values: TenantFormValues) {
    setSubmitting(true);
    try {
      const created = await createTenant(toTenantPayload(values));
      setTenants((prev) => [created, ...prev]);
      setDialog({ type: 'closed' });
      toast.success(t('toasts.created', { name: created.name }));
    } catch (err) {
      toast.error(err instanceof TenantApiError ? err.message : t('errors.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleEdit(values: TenantFormValues) {
    if (dialog.type !== 'edit') return;
    setSubmitting(true);
    try {
      const updated = await updateTenant(dialog.tenant.id, toTenantPayload(values));
      setTenants((prev) => prev.map((tenant) => (tenant.id === updated.id ? updated : tenant)));
      setDialog({ type: 'closed' });
      toast.success(t('toasts.updated', { name: updated.name }));
    } catch (err) {
      toast.error(err instanceof TenantApiError ? err.message : t('errors.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleConfirmStatus() {
    if (dialog.type !== 'confirm-status') return;
    const { tenant, nextStatus } = dialog;
    setSubmitting(true);
    try {
      const updated = await updateTenant(tenant.id, { status: nextStatus });
      setTenants((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      setDialog({ type: 'closed' });
      toast.success(
        nextStatus === 'suspended'
          ? t('toasts.suspended', { name: updated.name })
          : t('toasts.reactivated', { name: updated.name })
      );
    } catch (err) {
      toast.error(err instanceof TenantApiError ? err.message : t('errors.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <Toaster />
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t('tenants.title')}</h1>
        <Button type="button" onClick={() => setDialog({ type: 'create' })}>
          <Plus className="size-4" aria-hidden="true" />
          {t('actions.newTenant')}
        </Button>
      </div>

      {loading && (
        <p className="mt-8 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {t('states.loading')}
        </p>
      )}

      {!loading && error && (
        <div className="mt-8 flex flex-col items-start gap-2 rounded-md border border-border p-6 text-sm">
          <p className="flex items-center gap-2 text-red-600">
            <AlertTriangle className="size-4" aria-hidden="true" />
            {t('states.error')}
          </p>
          <Button type="button" variant="ghost" size="sm" onClick={loadFirstPage}>
            {t('actions.retry')}
          </Button>
        </div>
      )}

      {!loading && !error && tenants.length === 0 && (
        <div className="mt-8 flex flex-col items-center gap-2 rounded-md border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          <Inbox className="size-6" aria-hidden="true" />
          {t('states.empty')}
        </div>
      )}

      {!loading && !error && tenants.length > 0 && (
        <>
          <table className="mt-6 w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th scope="col" className="py-2 font-medium">
                  {t('fields.name')}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t('fields.timezone')}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t('fields.defaultLocale')}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t('fields.status')}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t('fields.createdAt')}
                </th>
                <th scope="col" className="py-2 font-medium">
                  <span className="sr-only">{t('fields.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((tenant) => (
                <tr key={tenant.id} className="border-b border-border">
                  <td className="py-2">{tenant.name}</td>
                  <td className="py-2">{tenant.timezone}</td>
                  <td className="py-2">{t(`locales.${tenant.default_locale}`)}</td>
                  <td className="py-2">
                    <span
                      className={
                        tenant.status === 'active'
                          ? 'rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700'
                          : 'rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700'
                      }
                    >
                      {t(`status.${tenant.status}`)}
                    </span>
                  </td>
                  <td className="py-2">
                    {format.dateTime(new Date(tenant.created_at), {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                      timeZone: 'UTC',
                    })}
                  </td>
                  <td className="py-2">
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setDialog({ type: 'edit', tenant })}
                      >
                        {t('actions.edit')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-red-600"
                        onClick={() =>
                          setDialog({
                            type: 'confirm-status',
                            tenant,
                            nextStatus: tenant.status === 'active' ? 'suspended' : 'active',
                          })
                        }
                      >
                        {tenant.status === 'active' ? t('actions.suspend') : t('actions.reactivate')}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {nextCursor && (
            <div className="mt-4 flex justify-center">
              <Button type="button" variant="ghost" size="sm" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? t('states.loading') : t('actions.loadMore')}
              </Button>
            </div>
          )}
        </>
      )}

      <Dialog
        open={dialog.type === 'create'}
        onClose={() => setDialog({ type: 'closed' })}
        titleId={`${titleId}-create`}
      >
        <h2 id={`${titleId}-create`} className="text-lg font-semibold">
          {t('tenants.createTitle')}
        </h2>
        <div className="mt-4">
          <TenantForm
            submitting={submitting}
            onSubmit={handleCreate}
            onCancel={() => setDialog({ type: 'closed' })}
          />
        </div>
      </Dialog>

      <Dialog
        open={dialog.type === 'edit'}
        onClose={() => setDialog({ type: 'closed' })}
        titleId={`${titleId}-edit`}
      >
        <h2 id={`${titleId}-edit`} className="text-lg font-semibold">
          {t('tenants.editTitle')}
        </h2>
        <div className="mt-4">
          {dialog.type === 'edit' && (
            <TenantForm
              tenant={dialog.tenant}
              submitting={submitting}
              onSubmit={handleEdit}
              onCancel={() => setDialog({ type: 'closed' })}
            />
          )}
        </div>
      </Dialog>

      <Dialog
        open={dialog.type === 'confirm-status'}
        onClose={() => setDialog({ type: 'closed' })}
        titleId={`${titleId}-confirm`}
        role="alertdialog"
      >
        {dialog.type === 'confirm-status' && (
          <>
            <h2 id={`${titleId}-confirm`} className="text-lg font-semibold">
              {dialog.nextStatus === 'suspended' ? t('tenants.suspendTitle') : t('tenants.reactivateTitle')}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {dialog.nextStatus === 'suspended'
                ? t('tenants.suspendConfirm', { name: dialog.tenant.name })
                : t('tenants.reactivateConfirm', { name: dialog.tenant.name })}
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setDialog({ type: 'closed' })}>
                {t('actions.cancel')}
              </Button>
              <Button type="button" disabled={submitting} onClick={handleConfirmStatus}>
                {t('actions.confirm')}
              </Button>
            </div>
          </>
        )}
      </Dialog>
    </div>
  );
}
