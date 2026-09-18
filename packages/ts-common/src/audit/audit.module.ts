import { type DynamicModule, Module, type Type } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditInterceptor } from './audit.interceptor.js';
import { NatsAuditSink } from './nats-audit-sink.js';
import { AuditSink } from './types.js';

export * from './audit.interceptor.js';
export * from './nats-audit-sink.js';
export * from './types.js';

export interface AuditModuleOptions {
  /** Custom `AuditSink` (core's Postgres-backed sink, F0.6.T7). Defaults to `NatsAuditSink`. */
  sink?: Type<AuditSink>;
}

@Module({})
export class AuditModule {
  /** Registers `AuditInterceptor` globally and the given (or default) `AuditSink`. */
  static forRoot(options: AuditModuleOptions = {}): DynamicModule {
    return {
      module: AuditModule,
      global: true,
      providers: [
        { provide: AuditSink, useClass: options.sink ?? NatsAuditSink },
        { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
      ],
      exports: [AuditSink],
    };
  }
}
