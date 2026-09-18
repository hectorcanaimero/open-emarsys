import { Module } from '@nestjs/common';
import { FieldRegistry } from './field-registry.js';
import { FieldsController, InternalFieldsController, PublicFieldsController } from './fields.controller.js';
import { FieldsService } from './fields.service.js';
import { KeyResolver } from './key-resolver.js';

/** Field definitions (FR-7): admin and public APIs, the per-tenant registry and key resolution. */
@Module({
  controllers: [FieldsController, PublicFieldsController, InternalFieldsController],
  providers: [FieldsService, FieldRegistry, KeyResolver],
  exports: [FieldRegistry, KeyResolver],
})
export class FieldsModule {}
