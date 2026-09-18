import { CSRF_COOKIE, CSRF_HEADER } from '@/lib/session/constants';

// The importer/contacts contracts are not exported by @oe/ts-contracts yet, so the shapes used here
// are declared locally (subset of contracts/openapi/admin-v1/{importer,contacts}.yaml).
export type JobStatus = 'draft' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  kind: 'import' | 'export';
  status: JobStatus;
  params: Record<string, unknown>;
  progress: { rows_read: number; rows_ok: number; rows_failed: number };
  result_url: string | null;
  result_url_expires_at: string | null;
  error_report_url: string | null;
  error_report_url_expires_at: string | null;
  error?: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface ImportPreview {
  delimiter: string;
  encoding: 'utf-8' | 'latin-1';
  has_header: boolean;
  columns: string[];
  rows: string[][];
}

export interface Field {
  field_id: number;
  api_name: string;
  labels: Record<string, string>;
  unique: boolean;
  deleted_at: string | null;
}

export interface ContactList {
  id: string;
  name: string;
}

export interface RelationalTable {
  id: string;
  name: string;
  columns: { name: string }[];
}

const BASE = '/api/admin';

const csrfToken = () =>
  document.cookie
    .split('; ')
    .find((c) => c.startsWith(`${CSRF_COOKIE}=`))
    ?.slice(CSRF_COOKIE.length + 1) ?? '';

export async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { [CSRF_HEADER]: csrfToken(), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as T;
}

/** PUT straight to the presigned URL; fetch has no upload progress, XHR does. */
export function uploadFile(url: string, file: File, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('content-type', file.type || 'text/csv');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(String(xhr.status))));
    xhr.onerror = () => reject(new Error('network'));
    xhr.send(file);
  });
}

export const fetchFields = async () =>
  (await api<{ items: Field[] }>('GET', '/fields')).items.filter((f) => !f.deleted_at);
export const fetchLists = async () => (await api<{ items: ContactList[] }>('GET', '/lists?limit=200')).items;
export const fetchTables = async () =>
  (await api<{ items: RelationalTable[] }>('GET', '/relational-tables?limit=200')).items;
