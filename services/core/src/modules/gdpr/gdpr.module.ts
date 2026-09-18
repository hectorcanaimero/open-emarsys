import { Module } from '@nestjs/common';
import { ContactsWriteModule } from '../contacts-write/contacts-write.module.js';
import { FieldsModule } from '../fields/fields.module.js';
import { SystemPrismaModule } from '../tenants/system-prisma.module.js';
import { ExportStorage } from './export-storage.js';
import { AdminGdprController, PublicGdprController } from './gdpr.controller.js';
import { GdprService } from './gdpr.service.js';

/**
 * GDPR access and erasure (FR-15, NFR-10). Needs `NatsModule`, `PrismaModule` and the
 * `CORE_MINIO_*` variables of `storageConfigSchema`.
 */
@Module({
  imports: [FieldsModule, SystemPrismaModule, ContactsWriteModule],
  controllers: [PublicGdprController, AdminGdprController],
  providers: [GdprService, { provide: ExportStorage, useFactory: () => ExportStorage.fromEnv() }],
  exports: [GdprService],
})
export class GdprModule {}
