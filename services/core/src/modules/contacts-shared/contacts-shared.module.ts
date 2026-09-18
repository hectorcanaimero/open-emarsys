import { Module } from '@nestjs/common';
import { SystemFieldsSeeder } from './system-fields.seeder.js';

/** Pieces of the contacts schema shared by the contacts feature modules (F1.2). */
@Module({
  providers: [SystemFieldsSeeder],
  exports: [SystemFieldsSeeder],
})
export class ContactsSharedModule {}
