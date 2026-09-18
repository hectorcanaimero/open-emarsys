import { Module } from '@nestjs/common';
import { FieldsModule } from '../fields/fields.module.js';
import { ContactStreamService } from './contact-stream.service.js';
import { AdminContactsQueryController, InternalContactsQueryController, PublicContactsQueryController } from './contacts-query.controller.js';
import { ContactsQueryService } from './contacts-query.service.js';

/** Contact reads (FR-9, FR-10, FR-12): public getdata, admin search and profile, internal lookup and NDJSON stream. */
@Module({
  imports: [FieldsModule],
  controllers: [PublicContactsQueryController, AdminContactsQueryController, InternalContactsQueryController],
  providers: [ContactsQueryService, ContactStreamService],
})
export class ContactsQueryModule {}
