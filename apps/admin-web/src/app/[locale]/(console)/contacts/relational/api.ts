// ponytail: hand-written slice of admin-v1/contacts.yaml, same as lists/api.ts.
export { api } from '../lists/api';
export type { Page } from '../lists/api';

export const COLUMN_TYPES = ['text', 'number', 'date', 'boolean'] as const;
export type ColumnType = 'text' | 'number' | 'date' | 'boolean' | 'single_choice' | 'multi_choice';
export interface Column {
  name: string;
  type: ColumnType;
}
export interface RelationalTable {
  id: string;
  name: string;
  key_field: string;
  columns: Column[];
  created_at: string;
  updated_at: string;
}
export interface RelationalRow {
  key: string;
  data: Record<string, string | number | boolean | number[] | null>;
  updated_at: string;
}
export interface GdprRequest {
  id: string;
  contact_id: string | null;
  kind: 'export' | 'forget';
  status: 'queued' | 'running' | 'done' | 'failed';
  requested_at: string;
  completed_at: string | null;
  result_url: string | null;
  result_expires_at: string | null;
  error?: string | null;
}
