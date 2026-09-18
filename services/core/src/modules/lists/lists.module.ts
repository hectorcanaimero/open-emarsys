import { Module } from '@nestjs/common';
import { ContactsWriteModule } from '../contacts-write/contacts-write.module.js';
import { FieldsModule } from '../fields/fields.module.js';
import { AdminListsController, InternalListsController, PublicListsController } from './lists.controller.js';
import { ListsService } from './lists.service.js';

/** Contact lists (FR-13): public, admin and internal APIs. Needs `NatsModule` and `PrismaModule`. */
@Module({
  imports: [FieldsModule, ContactsWriteModule],
  controllers: [PublicListsController, AdminListsController, InternalListsController],
  providers: [ListsService],
  exports: [ListsService],
})
export class ListsModule {}
