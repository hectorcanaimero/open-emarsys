import { Module } from '@nestjs/common';
import { FieldsModule } from '../fields/fields.module.js';
import { SystemPrismaModule } from '../tenants/system-prisma.module.js';
import { AdminContactsWriteController, InternalContactsWriteController, PublicContactsWriteController } from './contacts-write.controller.js';
import { ContactsWriteService } from './contacts-write.service.js';
import { ContactsOutbox, OutboxRelay } from './outbox.js';

/** Contact writes (FR-8) and their events through the outbox (NFR-11). Needs `NatsModule` and `PrismaModule`. */
@Module({
  imports: [FieldsModule, SystemPrismaModule],
  controllers: [PublicContactsWriteController, AdminContactsWriteController, InternalContactsWriteController],
  providers: [ContactsWriteService, ContactsOutbox, OutboxRelay],
  exports: [ContactsWriteService, ContactsOutbox],
})
export class ContactsWriteModule {}
