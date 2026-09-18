import { Module } from '@nestjs/common';
import { FieldsModule } from '../fields/fields.module.js';
import { InternalRelationalController, PublicRelationalController, RelationalController } from './relational.controller.js';
import { RelationalService } from './relational.service.js';

/** Relational data tables (FR-16): definitions, per-contact rows, public and internal upsert. */
@Module({
  imports: [FieldsModule],
  controllers: [RelationalController, PublicRelationalController, InternalRelationalController],
  providers: [RelationalService],
  exports: [RelationalService],
})
export class RelationalModule {}
