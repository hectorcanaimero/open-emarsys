import { once } from 'node:events';
import type { Writable } from 'node:stream';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';

const BATCH = 500;

/**
 * NDJSON export of a tenant's contacts (FR-12): a server-side cursor on a dedicated `pg`
 * connection (the tenant is set with `set_config` inside the transaction, so RLS applies),
 * fetched in batches and written with backpressure, so memory stays flat for any row count.
 */
@Injectable()
export class ContactStreamService implements OnModuleDestroy {
  private pool?: pg.Pool;

  private getPool(): pg.Pool {
    if (!this.pool) {
      const url = new URL(process.env.DATABASE_URL ?? '');
      url.searchParams.delete('schema'); // Prisma-only parameter
      this.pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
    }
    return this.pool;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  /** Whether `listId` exists in the tenant. */
  async listExists(tenantId: string, listId: string): Promise<boolean> {
    return this.withTx(tenantId, async (c) => {
      const r = await c.query('SELECT 1 FROM contacts.lists WHERE id = $1::uuid', [listId]);
      return r.rowCount === 1;
    });
  }

  /** Writes one `{"id","fields"}` line per live contact ordered by id; resolves when done or `out` closed. */
  async stream(tenantId: string, fieldIds: number[], listId: string | undefined, out: Writable): Promise<void> {
    const pairs = fieldIds.map((f) => `'${f}', c.data -> '${f}'`).join(', '); // fieldIds are validated integers
    const params: string[] = [tenantId];
    let join = '';
    if (listId) {
      params.push(listId);
      join = 'JOIN contacts.list_members m ON m.contact_id = c.id AND m.list_id = $2::uuid';
    }
    const sql = `SELECT jsonb_build_object('id', c.id, 'fields', jsonb_strip_nulls(jsonb_build_object(${pairs})))::text AS line
      FROM contacts.contacts c ${join} WHERE c.tenant_id = $1::uuid AND c.deleted_at IS NULL ORDER BY c.id`;
    let closed = out.destroyed;
    out.once('close', () => (closed = true));

    await this.withTx(tenantId, async (c) => {
      // DECLARE takes no bind parameters, so the (validated) UUIDs are inlined.
      await c.query(`DECLARE contacts_export NO SCROLL CURSOR FOR ${inline(sql, params)}`);
      for (;;) {
        const { rows } = await c.query<{ line: string }>(`FETCH ${BATCH} FROM contacts_export`);
        if (rows.length === 0 || closed) return;
        const chunk = `${rows.map((r) => r.line).join('\n')}\n`;
        if (!out.write(chunk)) await once(out, 'drain');
      }
    });
  }

  private async withTx<T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.getPool().connect();
    try {
      await c.query('BEGIN READ ONLY');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function inline(sql: string, params: string[]): string {
  return sql.replace(/\$(\d)/g, (_, n: string) => {
    const v = params[Number(n) - 1] ?? '';
    if (!UUID.test(v)) throw new Error('not a UUID');
    return `'${v}'`;
  });
}
