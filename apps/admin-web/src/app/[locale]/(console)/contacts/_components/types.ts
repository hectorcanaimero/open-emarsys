// ponytail: hand-written slice of admin-v1/contacts.yaml, same as lists/api.ts.
export type FieldValue = string | number | boolean | number[] | null;
export type Locale = 'es' | 'pt' | 'en';
export type Labels = Record<Locale, string>;
export interface Field {
  field_id: number;
  api_name: string;
  type: 'text' | 'number' | 'date' | 'boolean' | 'single_choice' | 'multi_choice';
  labels: Labels;
  choices: Array<{ id: number; api_name: string; labels: Labels }>;
  read_only: boolean;
  is_system: boolean;
}
export interface Contact {
  id: string;
  fields: Record<string, FieldValue>;
  version: number;
  created_at: string;
  updated_at: string;
}
export type ConsentChannel = 'email' | 'sms' | 'push';
export type ConsentValue = 1 | 2 | null;
export interface Consent {
  id: string;
  channel: ConsentChannel;
  value: ConsentValue;
  source: string;
  text: string | null;
  changed_at: string;
}
export interface ContactProfile extends Contact {
  consents: Record<ConsentChannel, ConsentValue>;
  lists: Array<{ id: string; name: string }>;
}

/** Consent channels are stored in these system fields; the consent panel owns them. */
export const CONSENT_FIELD_IDS = [31, 32, 33];
