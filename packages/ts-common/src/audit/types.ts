/** `identity.audit_log` row shape (arch Data model → core/identity), FR-6. */
export interface AuditEntry {
  /** `null` only for platform-operator actions (`tenant_id = null` principals). */
  tenant_id: string | null;
  actor_type: 'user' | 'client' | 'service';
  actor_id: string;
  /** `<resource_type>.<create|update|delete>`. */
  action: string;
  resource_type: string;
  resource_id: string | null;
  diff: unknown;
  /** ISO 8601 timestamp of the audited request. */
  at: string;
}

/**
 * Destination for audit entries. core provides a Postgres-backed
 * implementation that writes `identity.audit_log` directly (F0.6.T7); every
 * other service uses `NatsAuditSink`.
 */
export abstract class AuditSink {
  abstract record(entry: AuditEntry): Promise<void>;
}
