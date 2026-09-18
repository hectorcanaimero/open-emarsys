import { Module } from '@nestjs/common';
import { ContactsWriteModule } from '../contacts-write/contacts-write.module.js';
import { FieldsModule } from '../fields/fields.module.js';
import { AdminConsentsController, PublicConsentsController } from './consents.controller.js';
import { ConsentsService } from './consents.service.js';

/** Consent history per channel (FR-14). Needs `NatsModule` and `PrismaModule`. */
@Module({
  imports: [ContactsWriteModule, FieldsModule],
  controllers: [PublicConsentsController, AdminConsentsController],
  providers: [ConsentsService],
})
export class ConsentsModule {}
