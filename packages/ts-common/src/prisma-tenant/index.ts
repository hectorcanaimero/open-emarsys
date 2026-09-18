import { AsyncLocalStorage } from 'node:async_hooks';
import {
  CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  Kysely,
  PostgresDialect,
  type PostgresDialectConfig,
  type QueryResult,
  type TransactionSettings,
} from 'kysely';
import { requireTenant } from '../tenant/index.js';

export interface TenantScopeOptions {
  /**
   * Role with BYPASSRLS that `withSystemScope` switches to (`SET LOCAL ROLE`). The connecting
   * user must be a member of it. Without it, system scope runs with no tenant set, so RLS
   * tables return nothing.
   */
  systemRole?: string;
}

const systemScope = new AsyncLocalStorage<true>();
const inScopedTx = new AsyncLocalStorage<true>();

/** Runs `fn` as a platform operator: no tenant required, `systemRole` applied if configured. */
export function withSystemScope<T>(fn: () => T): T {
  return systemScope.run(true, fn);
}

type Statement = [sql: string, params: string[]];

/** The statement that scopes the current transaction, or none (system scope without a role). */
function scopeStatement(systemRole: string | undefined): Statement | undefined {
  if (!systemScope.getStore()) {
    return ["select set_config('app.tenant_id', $1, true)", [requireTenant()]];
  }
  return systemRole ? [`set local role "${systemRole}"`, []] : undefined;
}

function checkRole(role: string | undefined): string | undefined {
  if (role !== undefined && !/^[a-z_][a-z0-9_]*$/.test(role)) {
    throw new Error(`invalid systemRole: ${role}`);
  }
  return role;
}

// Structural type so this module never loads a generated Prisma client.
/* eslint-disable @typescript-eslint/no-explicit-any */
interface PrismaLike {
  $extends(extension: any): any;
  $transaction(arg: any, options?: any): Promise<any>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): any;
}

/**
 * Scopes every model operation to the tenant in `TenantContext`: each one runs in its own
 * transaction preceded by `set_config('app.tenant_id', $1, true)`. `$transaction` sets the
 * tenant once and model operations on `tx` reuse that transaction. Raw queries on the client
 * (`$queryRaw`) are not scoped; run them on `tx` or use `createKysely`.
 */
export function withTenantScope<C extends PrismaLike>(base: C, options: TenantScopeOptions = {}): C {
  const role = checkRole(options.systemRole);
  const extended: C = base.$extends({
    query: {
      $allModels: {
        async $allOperations({ args, query }: { args: unknown; query: (args: unknown) => any }) {
          if (inScopedTx.getStore()) return query(args);
          const stmt = scopeStatement(role);
          if (!stmt) return query(args);
          const [, result] = await base.$transaction([
            base.$executeRawUnsafe(stmt[0], ...stmt[1]),
            query(args),
          ]);
          return result;
        },
      },
    },
  });

  const $transaction = async (arg: any, txOptions?: any): Promise<any> => {
    const stmt = scopeStatement(role);
    if (typeof arg === 'function') {
      return extended.$transaction(
        (tx: PrismaLike) =>
          inScopedTx.run(true, async () => {
            if (stmt) await tx.$executeRawUnsafe(stmt[0], ...stmt[1]);
            return arg(tx);
          }),
        txOptions
      );
    }
    if (!stmt) return extended.$transaction(arg, txOptions);
    const results = await inScopedTx.run(true, () =>
      extended.$transaction([base.$executeRawUnsafe(stmt[0], ...stmt[1]), ...arg], txOptions)
    );
    return results.slice(1);
  };

  return new Proxy(extended, {
    get: (target, prop) => (prop === '$transaction' ? $transaction : Reflect.get(target, prop)),
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

class ScopedConnection implements DatabaseConnection {
  inTransaction = false;

  constructor(
    readonly inner: DatabaseConnection,
    private readonly systemRole: string | undefined
  ) {}

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    if (this.inTransaction) return this.inner.executeQuery<R>(query);
    const stmt = scopeStatement(this.systemRole);
    if (!stmt) return this.inner.executeQuery<R>(query);
    await this.inner.executeQuery(CompiledQuery.raw('begin'));
    try {
      await this.inner.executeQuery(CompiledQuery.raw(...stmt));
      const result = await this.inner.executeQuery<R>(query);
      await this.inner.executeQuery(CompiledQuery.raw('commit'));
      return result;
    } catch (err) {
      await this.inner.executeQuery(CompiledQuery.raw('rollback')).catch(() => undefined);
      throw err;
    }
  }

  streamQuery<R>(query: CompiledQuery, chunkSize?: number): AsyncIterableIterator<QueryResult<R>> {
    if (!this.inTransaction) throw new Error('streamQuery must run inside db.transaction()');
    return this.inner.streamQuery<R>(query, chunkSize);
  }
}

/** Wraps a Kysely driver so every query runs with the tenant (or system role) set. */
class ScopedDriver implements Driver {
  constructor(
    private readonly inner: Driver,
    private readonly systemRole: string | undefined
  ) {}

  init(): Promise<void> {
    return this.inner.init();
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    return new ScopedConnection(await this.inner.acquireConnection(), this.systemRole);
  }

  async beginTransaction(conn: ScopedConnection, settings: TransactionSettings): Promise<void> {
    // Resolve the scope before BEGIN: Kysely does not roll back if beginTransaction throws.
    const stmt = scopeStatement(this.systemRole);
    await this.inner.beginTransaction(conn.inner, settings);
    conn.inTransaction = true;
    try {
      if (stmt) await conn.inner.executeQuery(CompiledQuery.raw(...stmt));
    } catch (err) {
      await this.rollbackTransaction(conn);
      throw err;
    }
  }

  async commitTransaction(conn: ScopedConnection): Promise<void> {
    try {
      await this.inner.commitTransaction(conn.inner);
    } finally {
      conn.inTransaction = false;
    }
  }

  async rollbackTransaction(conn: ScopedConnection): Promise<void> {
    try {
      await this.inner.rollbackTransaction(conn.inner);
    } finally {
      conn.inTransaction = false;
    }
  }

  releaseConnection(conn: ScopedConnection): Promise<void> {
    return this.inner.releaseConnection(conn.inner);
  }

  destroy(): Promise<void> {
    return this.inner.destroy();
  }
}

/** Kysely over a `pg` pool with the same tenant scoping as `withTenantScope` (D8). */
export function createKysely<DB>(
  pool: PostgresDialectConfig['pool'],
  options: TenantScopeOptions = {}
): Kysely<DB> {
  const role = checkRole(options.systemRole);
  const inner: Dialect = new PostgresDialect({ pool });
  const dialect: Dialect = {
    createAdapter: () => inner.createAdapter(),
    createDriver: () => new ScopedDriver(inner.createDriver(), role),
    createIntrospector: (db) => inner.createIntrospector(db),
    createQueryCompiler: () => inner.createQueryCompiler(),
  };
  return new Kysely<DB>({ dialect });
}
